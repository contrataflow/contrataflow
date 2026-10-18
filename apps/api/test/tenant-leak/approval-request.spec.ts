// Solicitação de aprovação sobre PostgreSQL real (US-051 · Validação, Permissão, Tenant incorreto,
// Concorrência e Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento (workflow padrão DEC-015 — APROVACAO_DFD com o titular da secretaria e
// APROVACAO_AUTORIDADE com o perfil AUTORIDADE_COMPETENTE). Prova que `DOCUMENT_INCOMPLETE`,
// `APPROVER_UNRESOLVED` e uma falha induzida DEPOIS das escritas desfazem a transação de origem
// inteira (nenhuma aprovação, cobertura, mudança de documento, tramitação, acesso, timeline,
// auditoria ou outbox), que a resolução de `ROLE` só aceita escopo sobre a unidade solicitante
// (nunca a unidade pela qual o processo só tramitou nem detentores de outro tenant), que o titular
// precisa de vínculo ativo NO tenant, e que o índice `approvals_pending_stage_key` admite uma única
// pendência por etapa sob concorrência. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PendingApprovalExistsError } from '#modules/approval/application/ports.js';
import { PrismaApprovalRepository } from '#modules/approval/infrastructure/approval.repositories.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';
import { registerTestDocumentFacts } from '../support/process-forward-fixtures.js';
import type { TestDocumentFacts } from '../support/process-forward-fixtures.js';

const A = '0192c051-0000-7000-8000-00000000010a';
const B = '0192c051-0000-7000-8000-00000000010b';
const ORG_A = '0192c051-0000-7000-8000-0000000010a0';
const ORG_B = '0192c051-0000-7000-8000-0000000010b0';
const OBRAS = '0192c051-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c051-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c051-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c051-0000-7000-8000-0000000010b1';
const ANA = '0192c051-0000-7000-8000-0000000010c1';
const MARTA = '0192c051-0000-7000-8000-0000000010c2';
const DAVI = '0192c051-0000-7000-8000-0000000010c3';
const VERA = '0192c051-0000-7000-8000-0000000010c4';
const MARCELO = '0192c051-0000-7000-8000-0000000010c5';
const BETO = '0192c051-0000-7000-8000-0000000010c6';
const ANA_M = '0192c051-0000-7000-8000-0000000010d1';
const VERA_M = '0192c051-0000-7000-8000-0000000010d4';
const MARCELO_M = '0192c051-0000-7000-8000-0000000010d5';
const BETO_M = '0192c051-0000-7000-8000-0000000010d6';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us051', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us051', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us051', 'ana@a.test', true, 'Carla Mendes'),
  ('${MARTA}', 'sub-marta-us051', 'marta@a.test', true, 'Roberto Lima'),
  ('${DAVI}', 'sub-davi-us051', 'davi@a.test', true, 'Davi Substituto'),
  ('${VERA}', 'sub-vera-us051', 'vera@a.test', true, 'Vera Souza'),
  ('${MARCELO}', 'sub-marcelo-us051', 'marcelo@a.test', true, 'Marcelo Alves'),
  ('${BETO}', 'sub-beto-us051', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${MARTA}', '${DAVI}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c051-0000-7000-8000-0000000010d2', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c051-0000-7000-8000-0000000010d3', '${A}', '${DAVI}', 'INTERNAL', 'ACTIVE'),
  ('${VERA_M}', '${A}', '${VERA}', 'INTERNAL', 'ACTIVE'),
  ('${MARCELO_M}', '${A}', '${MARCELO}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c051-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c051-0000-7000-8000-0000000010e2', '${A}', '${ANA_M}', '${PLANEJAMENTO}', false),
  ('0192c051-0000-7000-8000-0000000010e3', '${A}', '${VERA_M}', '${PLANEJAMENTO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

interface Target {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Solicitar aprovação sobre PostgreSQL (US-051)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let facts: TestDocumentFacts;
  let catalog: { contractingType: string; origin: string };

  const forward = (process: Target, transitionId: string) =>
    request(api.server)
      .post(`/api/v1/processes/${process.id}/forward`)
      .set('Authorization', api.bearer('sub-ana-us051', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.stageId, transitionId });
  const one = async <T extends Row>(sql: string, params: unknown[]): Promise<T> => {
    const [row] = await db.admin<T>(sql, params);
    if (!row) throw new Error(`sem linha: ${sql}`);
    return row;
  };
  const transitionOf = async (processId: string, key: string) =>
    (
      await one<{ id: string }>(
        `SELECT t.id FROM workflow_transitions t JOIN processes p ON p.workflow_version_id = t.workflow_version_id
          WHERE p.id = $1 AND t.key = $2`,
        [processId, key],
      )
    ).id;
  const roleOf = async (tenantId: string, key: string) =>
    (
      await one<{ id: string }>('SELECT id FROM roles WHERE tenant_id = $1 AND key = $2', [
        tenantId,
        key,
      ])
    ).id;
  const typeOf = async (code: string) =>
    (
      await one<{ id: string }>(
        'SELECT id FROM document_types WHERE tenant_id = $1 AND code = $2',
        [A, code],
      )
    ).id;

  /** PRC-02 (Ana, na ABERTURA do workflow padrão). */
  async function createProcess(): Promise<Target> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us051', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: ProcessDto }).data;
    return { id: created.id, stageId: created.currentStage?.id ?? '', version: created.version };
  }

  /** Processo levado ao TERMO_REFERENCIA (Coordenadoria, Ana responsável) com o TR "completo". */
  async function processAtTermOfReference(): Promise<Target> {
    const created = await createProcess();
    const stageId = randomUUID();
    const stage = (
      await one<{ id: string }>(
        `SELECT s.id FROM workflow_stages s JOIN processes p ON p.workflow_version_id = s.workflow_version_id
          WHERE p.id = $1 AND s.key = 'TERMO_REFERENCIA'`,
        [created.id],
      )
    ).id;
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = now() WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = now() WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${stage}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${ANA}', '2026-10-01T12:00:00Z', 10, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${PLANEJAMENTO}', '${ANA}',
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${stage}', current_department_id = '${PLANEJAMENTO}'
        WHERE id = '${created.id}';
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${PLANEJAMENTO}', 'CURRENT');
       COMMIT;`,
    );
    facts.set(created.id, [
      {
        documentTypeCode: 'TR',
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 1,
        approvedAt: null,
      },
    ]);
    return { id: created.id, stageId, version: created.version };
  }

  /** DFD finalizado (v1) gravado direto, para a cobertura de APROVACAO_DFD. */
  async function finalizedDfd(
    processId: string,
  ): Promise<{ documentId: string; versionId: string }> {
    const type = await typeOf('DFD');
    const documentId = randomUUID();
    const versionId = randomUUID();
    await db.admin(`
      BEGIN;
      INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, singleton_key,
        current_version_id, finalized_at, finalized_by_id, created_by_id)
      VALUES ('${documentId}', '${A}', '${processId}', '${type}', 'DFD da manutenção', 'FINALIZED',
        '${type}', '${versionId}', now(), '${ANA}', '${ANA}');
      INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number, reason,
        status_at_creation, content, content_hash, created_by_id)
      VALUES ('${versionId}', '${A}', '${documentId}', '${processId}', 1, 'FINALIZATION', 'FINALIZED',
        '{}'::jsonb, '${'d'.repeat(64)}', '${ANA}');
      COMMIT;`);
    facts.set(processId, [
      {
        documentTypeCode: 'DFD',
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 1,
        approvedAt: null,
      },
    ]);
    return { documentId, versionId };
  }

  /** Tudo que a solicitação (e o encaminhamento) gravam — para provar o rollback. */
  const effects = async (id: string) => ({
    process: await db.admin<Row>(
      'SELECT status::text, version, current_stage_id, current_department_id FROM processes WHERE id = $1',
      [id],
    ),
    stages: await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence, action::text FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    approvals: await db.admin<Row>(
      `SELECT status::text, subject_type::text, approver_type::text, approver_user_id,
              approver_role_id, approver_department_id, allow_deputy
         FROM approvals WHERE process_id = $1`,
      [id],
    ),
    coverage: await db.admin<Row>(
      `SELECT ad.document_id, ad.document_version_id FROM approval_documents ad
         JOIN approvals a ON a.tenant_id = ad.tenant_id AND a.id = ad.approval_id
        WHERE a.process_id = $1`,
      [id],
    ),
    documents: await db.admin<Row>(
      `SELECT id, status::text, pending_approval_id, current_version_id FROM documents
        WHERE process_id = $1 ORDER BY id`,
      [id],
    ),
    versions: await db.admin<Row>(
      'SELECT id FROM document_versions WHERE process_id = $1 ORDER BY id',
      [id],
    ),
    access: await db.admin<Row>(
      `SELECT reason::text, department_id, user_id, revoked_at IS NOT NULL AS revoked
         FROM process_access WHERE process_id = $1 ORDER BY reason, department_id, user_id`,
      [id],
    ),
    timeline: await db.admin<Row>(
      'SELECT type::text FROM process_timeline_entries WHERE process_id = $1 ORDER BY type',
      [id],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action NOT IN ('process.create', 'dfd.create') ORDER BY action",
      [id],
    ),
    events: await db.admin<Row>(
      `SELECT event_type FROM outbox_events WHERE process_id = $1
          AND event_type NOT IN ('ProcessCreated', 'DocumentCreated', 'DocumentVersionCreated')
        ORDER BY event_type`,
      [id],
    ),
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        {
          token: TOKEN_VERIFIER,
          value: new FakeJwksProvider({
            signingKey: TEST_SIGNING_KEY,
            issuer: TEST_ISSUER,
            audiences: config.oidc.audiences,
            clockToleranceSeconds: 30,
          }),
        },
      ],
    });
    membership.inner = api.app.get(PrismaIdentityRepository);
    facts = registerTestDocumentFacts(api);
    const seeders = [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    catalog = {
      contractingType: (
        await one<{ id: string }>(
          "SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = 'CONTRACTING_TYPE' AND code = 'AQUISICAO_BENS'",
          [A],
        )
      ).id,
      origin: (
        await one<{ id: string }>(
          "SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = 'PROCESS_ORIGIN' AND code = 'DEMANDA_NAO_PREVISTA'",
          [A],
        )
      ).id,
    };
    // "Vera": AUTORIDADE_COMPETENTE só sobre a Coordenadoria (por onde os processos tramitam);
    // "Beto": o perfil com escopo TENANT, mas no tenant B.
    await db.admin(`
      INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type,
        scope_department_id, include_subtree, valid_from, granted_by_id) VALUES
        ('${randomUUID()}', '${A}', '${VERA_M}', '${await roleOf(A, 'AUTORIDADE_COMPETENTE')}',
         'DEPARTMENT', '${PLANEJAMENTO}', true, '2026-01-01T00:00:00Z', '${ANA}'),
        ('${randomUUID()}', '${B}', '${BETO_M}', '${await roleOf(B, 'AUTORIDADE_COMPETENTE')}',
         'TENANT', NULL, true, '2026-01-01T00:00:00Z', '${BETO}');`);
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Validação] DFD coberto incompleto: 422 DOCUMENT_INCOMPLETE e nada persiste (documento, versão, aprovação, tramitação)', async () => {
    const process = await createProcess();
    const dfd = await request(api.server)
      .post(`/api/v1/processes/${process.id}/dfds`)
      .set('Authorization', api.bearer('sub-ana-us051', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfd.status, JSON.stringify(dfd.body)).toBe(201);
    // A regra do workflow passa (fato de teste); a completude real do DFD (DOC-08) não.
    facts.set(process.id, [
      {
        documentTypeCode: 'DFD',
        status: 'DRAFT',
        isComplete: true,
        versionNumber: null,
        approvedAt: null,
      },
    ]);
    const before = await effects(process.id);
    const response = await forward(process, await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD'));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_INCOMPLETE');
    expect(await effects(process.id)).toEqual(before);
  });

  it('[Falha de banco] falha induzida DEPOIS de submeter a cobertura desfaz tudo; sem ela, titular + substituto com APPROVER', async () => {
    const process = await createProcess();
    const dfd = await finalizedDfd(process.id);
    const transitionId = await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD');
    await db.admin(`
      CREATE FUNCTION test_fail_approval_documents() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'falha induzida no teste'; END $fn$;
      CREATE TRIGGER test_fail_approval_documents BEFORE INSERT ON approval_documents
        FOR EACH ROW EXECUTE FUNCTION test_fail_approval_documents();`);
    try {
      const before = await effects(process.id);
      const failed = await forward(process, transitionId);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_approval_documents ON approval_documents; DROP FUNCTION test_fail_approval_documents();',
      );
    }

    const ok = await forward(process, transitionId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const approvalId = (ok.body as { data: ForwardedProcessDto }).data.approval?.id;
    const after = await effects(process.id);
    expect(after.approvals).toEqual([
      {
        status: 'PENDING',
        subject_type: 'PROCESS_STAGE',
        approver_type: 'DEPARTMENT_HEAD',
        approver_user_id: MARTA,
        approver_role_id: null,
        approver_department_id: OBRAS,
        allow_deputy: true,
      },
    ]);
    expect(after.coverage).toEqual([
      { document_id: dfd.documentId, document_version_id: dfd.versionId },
    ]);
    expect(after.documents).toEqual([
      {
        id: dfd.documentId,
        status: 'FINALIZED',
        pending_approval_id: approvalId,
        current_version_id: dfd.versionId,
      },
    ]);
    expect(after.access).toEqual(
      expect.arrayContaining([
        { reason: 'APPROVER', department_id: null, user_id: MARTA, revoked: false },
        { reason: 'APPROVER', department_id: null, user_id: DAVI, revoked: false },
      ]),
    );
    expect(after.timeline.map((row) => row.type)).toContain('APPROVAL_REQUESTED');
    expect(after.audit.map((row) => row.action)).toContain('approval.request');
    expect(after.events.map((row) => row.event_type)).toContain('ApprovalRequested');
  });

  it('[Permissão] ROLE: Vera (escopo só na unidade de tramitação) e Beto (outro tenant) não resolvem; Marcelo (escopo na solicitante) sim', async () => {
    const first = await processAtTermOfReference();
    const toAuthority = await transitionOf(first.id, 'ENVIAR_AUTORIDADE');
    const before = await effects(first.id);
    const refused = await forward(first, toAuthority);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(problemDetailsSchema.parse(refused.body).code).toBe('APPROVER_UNRESOLVED');
    expect(JSON.stringify(refused.body)).not.toContain('LEAK-B');
    expect(await effects(first.id)).toEqual(before);

    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type,
         scope_department_id, include_subtree, valid_from, granted_by_id)
       VALUES ($1, $2, $3, $4, 'DEPARTMENT', $5, false, '2026-01-01T00:00:00Z', $6)`,
      [randomUUID(), A, MARCELO_M, await roleOf(A, 'AUTORIDADE_COMPETENTE'), OBRAS, ANA],
    );
    const process = await processAtTermOfReference();
    const ok = await forward(process, toAuthority);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await effects(process.id);
    expect(after.approvals).toEqual([
      {
        status: 'PENDING',
        subject_type: 'PROCESS_STAGE',
        approver_type: 'ROLE',
        approver_user_id: null,
        approver_role_id: await roleOf(A, 'AUTORIDADE_COMPETENTE'),
        approver_department_id: null,
        allow_deputy: false,
      },
    ]);
    // FA-02: nenhum documento coberto existe — aprovação sem cobertura; ROLE não concede APPROVER.
    expect(after.coverage).toEqual([]);
    expect(after.access.filter((row) => row.reason === 'APPROVER')).toEqual([]);
    expect(after.timeline.map((row) => row.type)).toContain('APPROVAL_REQUESTED');
  });

  it('[Tenant incorreto] titular configurado com usuário de outro tenant não é resolvido e nada persiste', async () => {
    const process = await createProcess();
    await finalizedDfd(process.id);
    await db.admin(
      'UPDATE departments SET head_user_id = $1, deputy_user_id = NULL WHERE id = $2',
      [BETO, OBRAS],
    );
    try {
      const before = await effects(process.id);
      const refused = await forward(
        process,
        await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD'),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('APPROVER_UNRESOLVED');
      expect(JSON.stringify(refused.body)).not.toContain('LEAK-B');
      expect(await effects(process.id)).toEqual(before);
    } finally {
      await db.admin(
        'UPDATE departments SET head_user_id = $1, deputy_user_id = $2 WHERE id = $3',
        [MARTA, DAVI, OBRAS],
      );
    }
  });

  it('[Concorrência] índice de pendência única: duas aprovações PENDING para a mesma etapa — uma grava, a outra é recusada', async () => {
    const process = await createProcess();
    const repository = new PrismaApprovalRepository();
    const client = db.client('cf_app');
    const approval = (approvalId: string) => ({
      id: approvalId,
      tenantId: A,
      processId: process.id,
      subjectType: 'PROCESS_STAGE' as const,
      processStageId: process.stageId,
      documentId: null,
      title: 'Aprovação concorrente',
      requestedById: ANA,
      requestedAt: NOW,
      requestComment: null,
      approverType: 'USER' as const,
      approverUserId: MARTA,
      approverRoleId: null,
      approverDepartmentId: null,
      allowDeputy: false,
      dueAt: null,
      status: 'PENDING' as const,
      createdAt: NOW,
      createdById: ANA,
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          asTenant(A, () =>
            client.$tenantTransaction((tx) => repository.insert(tx, approval(randomUUID()), [])),
          ),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(4);
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(PendingApprovalExistsError);
      }
      expect(
        await db.admin('SELECT id FROM approvals WHERE process_stage_id = $1 AND status = $2', [
          process.stageId,
          'PENDING',
        ]),
      ).toHaveLength(1);
      // RLS: o tenant B não enxerga a aprovação de A.
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<Row[]>`SELECT id FROM approvals WHERE process_id = ${process.id}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
