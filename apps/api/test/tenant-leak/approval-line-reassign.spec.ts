// Redirecionar linha e retirar aprovação múltipla sobre PostgreSQL real (US-135 · Sucesso,
// Duplicidade, Tenant incorreto, Concorrência, Falha de banco e Falha de integração): a API inteira
// como `cf_app` (RLS) com os seeders reais do provisionamento e a etapa APROVACAO_DFD do workflow
// padrão configurada com a política `SEQUENTIAL` (1. titular da secretaria solicitante — Carla,
// substituto Diego; 2. o usuário Marcelo). Prova que o APV-06 "cancela e cria" a linha numa
// transação — prazo preservado, `ProcessAccess` `APPROVER` trocado, auditoria, timeline e
// `ApprovalReassigned` `PENDING` no outbox, sem o motivo em lugar nenhum; que uma falha induzida
// desfaz tudo (nenhuma linha nova); que o índice único parcial impede duas linhas vivas na mesma
// posição; que decisão × redirecionamento e dois redirecionamentos simultâneos resultam numa só
// linha viva (`FOR UPDATE`); que a retirada pela gestora (`PROCESS_ASSIGN`) mantém o voto e cancela
// o resto; e que as linhas de A não existem para B. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { APPROVAL_CLOCK } from '../../src/modules/approval/application/ports.js';
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

const A = '0192c135-0000-7000-8000-00000000010a';
const B = '0192c135-0000-7000-8000-00000000010b';
const ORG_A = '0192c135-0000-7000-8000-0000000010a0';
const ORG_B = '0192c135-0000-7000-8000-0000000010b0';
const OBRAS = '0192c135-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c135-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c135-0000-7000-8000-0000000010b1';
const ANA = '0192c135-0000-7000-8000-0000000010c1';
const CARLA = '0192c135-0000-7000-8000-0000000010c2';
const DIEGO = '0192c135-0000-7000-8000-0000000010c3';
const MARCELO = '0192c135-0000-7000-8000-0000000010c4';
const PAULA = '0192c135-0000-7000-8000-0000000010c5';
const MARTA = '0192c135-0000-7000-8000-0000000010c7';
const BETO = '0192c135-0000-7000-8000-0000000010c6';
const ANA_M = '0192c135-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-11-12T15:00:00.000Z');
const DUE = '2026-12-10T23:59:59.000Z';
const MFA = ['pwd', 'otp'];
const LEAVE = 'Marcelo está de licença médica';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['AUTORIDADE_COMPETENTE'],
  [DIEGO]: ['AUTORIDADE_COMPETENTE'],
  [MARCELO]: ['AUTORIDADE_COMPETENTE'],
  [PAULA]: ['AUTORIDADE_COMPETENTE'],
  [MARTA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us135', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us135', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us135', 'ana@a.test', true, 'Ana Requisitante'),
  ('${CARLA}', 'sub-carla-us135', 'carla@a.test', true, 'Carla Titular'),
  ('${DIEGO}', 'sub-diego-us135', 'diego@a.test', true, 'Diego Substituto'),
  ('${MARCELO}', 'sub-marcelo-us135', 'marcelo@a.test', true, 'Marcelo Procurador'),
  ('${PAULA}', 'sub-paula-us135', 'paula@a.test', true, 'Paula Controladora'),
  ('${MARTA}', 'sub-marta-us135', 'marta@a.test', true, 'Marta Gestora'),
  ('${BETO}', 'sub-beto-us135', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${CARLA}', '${DIEGO}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, '${BETO}', NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d3', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d4', '${A}', '${MARCELO}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d5', '${A}', '${PAULA}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d7', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c135-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c135-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** RN-APV-16: a etapa APROVACAO_DFD do workflow padrão de A com `SEQUENTIAL` e duas linhas. */
const STAGE_LINES = JSON.stringify({
  decisionPolicy: 'SEQUENTIAL',
  approvers: [
    {
      sequence: 1,
      approverType: 'DEPARTMENT_HEAD',
      approverUserId: null,
      approverRoleId: null,
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
      approverFixedDepartmentId: null,
      allowDeputy: true,
      label: null,
    },
    {
      sequence: 2,
      approverType: 'USER',
      approverUserId: MARCELO,
      approverRoleId: null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
      allowDeputy: true,
      label: 'Procurador-Geral',
    },
  ],
});

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

interface Pending {
  readonly processId: string;
  readonly approvalId: string;
  readonly documentId: string;
}

describe('Feature: Redirecionar linha e retirar aprovação múltipla sobre PostgreSQL (US-135)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let facts: TestDocumentFacts;
  let catalog: { contractingType: string; origin: string };

  const one = async <T extends Row>(sql: string, params: unknown[]): Promise<T> => {
    const [row] = await db.admin<T>(sql, params);
    if (!row) throw new Error(`sem linha: ${sql}`);
    return row;
  };
  const call = (
    route: string,
    body: Record<string, unknown>,
    options: { subject: string; tenant?: string; ifMatch?: string; key?: string },
  ) =>
    request(api.server)
      .post(`/api/v1/approvals/${route}`)
      .set('Authorization', api.bearer(options.subject, { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('If-Match', options.ifMatch ?? '"1"')
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const reassign = (
    approvalId: string,
    lineId: string,
    targetUserId: string,
    options: { subject?: string; tenant?: string; ifMatch?: string; key?: string } = {},
  ) =>
    call(
      `${approvalId}/approvers/${lineId}/reassign`,
      { approverType: 'USER', targetApproverUserId: targetUserId, reason: LEAVE },
      { subject: 'sub-marta-us135', ...options },
    );
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const linesOf = (approvalId: string) =>
    db.admin<Row & { id: string; version: number }>(
      `SELECT id, sequence, status::text, approver_user_id, decision::text, skipped_reason,
              reassigned_from_id, activated_at, due_at, version
         FROM approval_approvers WHERE approval_id = $1 ORDER BY sequence, created_at`,
      [approvalId],
    );
  const liveLine = async (approvalId: string, sequence: number) => {
    const line = (await linesOf(approvalId)).find(
      (candidate) => candidate.sequence === sequence && candidate.status !== 'CANCELED',
    );
    if (!line) throw new Error(`linha ${String(sequence)} ausente`);
    return line;
  };
  const approverAccess = (processId: string) =>
    db.admin<Row>(
      `SELECT user_id, source_id, revoked_at IS NOT NULL AS revoked FROM process_access
        WHERE process_id = $1 AND reason = 'APPROVER' ORDER BY granted_at, user_id`,
      [processId],
    );

  /** Processo na ABERTURA com o DFD finalizado, encaminhado à APROVACAO_DFD (`SEQUENTIAL`). */
  async function pendingDfdApproval(): Promise<Pending> {
    const created = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us135', { amr: MFA }))
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
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const process = (created.body as { data: ProcessDto }).data;
    const type = (
      await one<{ id: string }>(
        'SELECT id FROM document_types WHERE tenant_id = $1 AND code = $2',
        [A, 'DFD'],
      )
    ).id;
    const documentId = randomUUID();
    const versionId = randomUUID();
    const snapshot = {
      schemaVersion: 1,
      document: {
        id: documentId,
        code: null,
        title: 'DFD da manutenção',
        typeCode: 'DFD',
        kind: 'STRUCTURED',
        confidentiality: 'INTERNAL',
        versionNumber: 1,
      },
      template: null,
      process: {
        id: process.id,
        code: process.code,
        title: process.title,
        object: process.object,
        organizationName: 'Prefeitura Municipal de São José',
        organizationCnpj: null,
        requestingSecretariatName: null,
        requestingDepartmentName: null,
        isBudgetConfidential: false,
      },
      header: {},
      sections: {},
      collections: {},
      generatedAt: NOW.toISOString(),
    };
    const content = JSON.stringify(snapshot).replaceAll("'", "''");
    await db.admin(`
      BEGIN;
      INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, singleton_key,
        current_version_id, finalized_at, finalized_by_id, created_by_id)
      VALUES ('${documentId}', '${A}', '${process.id}', '${type}', 'DFD da manutenção', 'FINALIZED',
        '${type}', '${versionId}', now(), '${ANA}', '${ANA}');
      INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number, reason,
        status_at_creation, content, content_hash, created_by_id)
      VALUES ('${versionId}', '${A}', '${documentId}', '${process.id}', 1, 'FINALIZATION', 'FINALIZED',
        '${content}'::jsonb, '${'d'.repeat(64)}', '${ANA}');
      COMMIT;`);
    facts.set(process.id, [
      {
        documentTypeCode: 'DFD',
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 1,
        approvedAt: null,
      },
    ]);
    const transitionId = (
      await one<{ id: string }>(
        `SELECT t.id FROM workflow_transitions t JOIN processes p ON p.workflow_version_id = t.workflow_version_id
          WHERE p.id = $1 AND t.key = 'ENVIAR_APROVACAO_DFD'`,
        [process.id],
      )
    ).id;
    const forwarded = await request(api.server)
      .post(`/api/v1/processes/${process.id}/forward`)
      .set('Authorization', api.bearer('sub-ana-us135', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.currentStage?.id, transitionId });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approval = (forwarded.body as { data: ForwardedProcessDto }).data.approval;
    expect(approval).toMatchObject({ decisionPolicy: 'SEQUENTIAL' });
    return { processId: process.id, approvalId: approval?.id ?? '', documentId };
  }

  /** Background: Carla aprova a linha 1; a linha 2 de Marcelo fica PENDING com prazo próprio. */
  async function votedApproval(): Promise<Pending> {
    const pending = await pendingDfdApproval();
    const voted = await call(
      `${pending.approvalId}/decide`,
      { decision: 'APPROVE' },
      { subject: 'sub-carla-us135' },
    );
    expect(voted.status, JSON.stringify(voted.body)).toBe(200);
    // O prazo próprio da linha (SLA por linha — EP-030) só existe por SQL nesta fase.
    await db.admin(
      `UPDATE approval_approvers SET due_at = $2::timestamptz WHERE approval_id = $1 AND sequence = 2`,
      [pending.approvalId, DUE],
    );
    return pending;
  }

  /** Tudo que o redirecionamento grava — para provar o rollback. */
  const effects = async (processId: string, approvalId: string) => ({
    approval: await db.admin<Row>(
      'SELECT status::text, approver_user_id, version FROM approvals WHERE id = $1',
      [approvalId],
    ),
    lines: await linesOf(approvalId),
    access: await approverAccess(processId),
    timeline: await db.admin<Row>(
      'SELECT type::text FROM process_timeline_entries WHERE process_id = $1 ORDER BY type',
      [processId],
    ),
    audit: await db.admin<Row>(
      'SELECT action FROM audit_logs WHERE process_id = $1 ORDER BY action',
      [processId],
    ),
    events: await db.admin<Row>(
      'SELECT event_type, status::text FROM outbox_events WHERE process_id = $1 ORDER BY event_type',
      [processId],
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
        { token: APPROVAL_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
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
    // A etapa publicada recebe a política e as linhas no snapshot (o que o motor lê) — só o teste
    // contorna a imutabilidade (`session_replication_role`).
    await db.admin(`
      SET session_replication_role = replica;
      UPDATE workflow_versions v
         SET definition_snapshot = jsonb_set(v.definition_snapshot, '{stages}', (
           SELECT jsonb_agg(CASE WHEN s->>'key' = 'APROVACAO_DFD' THEN s || '${STAGE_LINES}'::jsonb
                                 ELSE s END ORDER BY ord)
             FROM jsonb_array_elements(v.definition_snapshot->'stages') WITH ORDINALITY AS t(s, ord)))
       WHERE v.tenant_id = '${A}' AND v.definition_snapshot IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.definition_snapshot->'stages') s
                      WHERE s->>'key' = 'APROVACAO_DFD');
      SET session_replication_role = origin;`);
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso]/[Falha de banco]/[Falha de integração] falha induzida desfaz tudo; o redirecionamento cancela e cria a linha com prazo, acesso, rastro e outbox PENDING', async () => {
    const pending = await votedApproval();
    const old = await liveLine(pending.approvalId, 2);
    const before = await effects(pending.processId, pending.approvalId);
    expect(before.access).toContainEqual({ user_id: MARCELO, source_id: old.id, revoked: false });

    // [Falha de banco] O outbox falha DEPOIS da troca das linhas e do acesso: nada fica.
    await db.admin(`
      CREATE FUNCTION test_fail_reassigned() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'ApprovalReassigned' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_reassigned BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_reassigned();`);
    try {
      const failed = await reassign(pending.approvalId, old.id, PAULA, {
        ifMatch: `"${String(old.version)}"`,
      });
      expect(failed.status).toBe(500);
      expect(await effects(pending.processId, pending.approvalId)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_reassigned ON outbox_events; DROP FUNCTION test_fail_reassigned();',
      );
    }

    const response = await reassign(pending.approvalId, old.id, PAULA, {
      ifMatch: `"${String(old.version)}"`,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const lines = await linesOf(pending.approvalId);
    expect(lines.map((line) => [line.sequence, line.status, line.skipped_reason])).toEqual([
      [1, 'APPROVED', null],
      [2, 'CANCELED', 'REASSIGNED'],
      [2, 'PENDING', null],
    ]);
    const created = await liveLine(pending.approvalId, 2);
    expect(created).toMatchObject({
      approver_user_id: PAULA,
      reassigned_from_id: old.id,
      activated_at: old.activated_at,
      due_at: new Date(DUE),
    });
    const after = await effects(pending.processId, pending.approvalId);
    expect(after.approval).toEqual([
      {
        status: 'PENDING',
        approver_user_id: PAULA,
        version: Number(before.approval[0]?.version) + 1,
      },
    ]);
    expect(after.access).toEqual(
      expect.arrayContaining([
        { user_id: MARCELO, source_id: old.id, revoked: true },
        { user_id: PAULA, source_id: created.id, revoked: false },
      ]),
    );
    expect(after.audit.map((row) => row.action)).toContain('approval.reassign');
    expect(after.timeline.map((row) => row.type)).toContain('APPROVAL_REASSIGNED');
    // O relay não roda no teste: o evento fica PENDING até ele voltar.
    const [event] = await db.admin<{ status: string; payload: Row }>(
      `SELECT status::text, payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'ApprovalReassigned'`,
      [pending.approvalId],
    );
    expect(event).toMatchObject({
      status: 'PENDING',
      payload: {
        approvalApproverId: created.id,
        fromApprovalApproverId: old.id,
        sequence: 2,
        toApproverUserId: PAULA,
        hasReason: true,
      },
    });
    // RN-APV-55: o motivo não é gravado em lugar nenhum.
    const leaked = await db.admin<Row>(
      `SELECT 'outbox' AS src FROM outbox_events WHERE payload::text LIKE $1
       UNION ALL SELECT 'audit' FROM audit_logs WHERE metadata::text LIKE $1 OR changes::text LIKE $1
       UNION ALL SELECT 'timeline' FROM process_timeline_entries WHERE params::text LIKE $1`,
      [`%${LEAVE}%`],
    );
    expect(leaked).toEqual([]);

    // RN-APV-52: o índice único parcial não deixa duas linhas vivas na mesma posição.
    await expect(
      db.admin(
        `INSERT INTO approval_approvers (id, tenant_id, approval_id, sequence, approver_type,
            approver_user_id, allow_deputy, status, activated_at, created_at, updated_at, version)
         VALUES ($1, $2, $3, 2, 'USER', $4, false, 'PENDING', now(), now(), now(), 1)`,
        [randomUUID(), A, pending.approvalId, DIEGO],
      ),
    ).rejects.toThrow(/approval_approvers_sequence_key|duplicate key/);
    // RN-APV-51: o voto de Carla é imutável (gatilho), mesmo no redirecionamento.
    await expect(
      db.admin(
        `UPDATE approval_approvers SET status = 'CANCELED', skipped_reason = 'REASSIGNED'
          WHERE approval_id = $1 AND sequence = 1`,
        [pending.approvalId],
      ),
    ).rejects.toThrow(/imutável/);
  });

  it('[Sucesso] a gestora (PROCESS_ASSIGN) retira com voto dado: o voto fica, o resto cancela e o acesso sai', async () => {
    const pending = await votedApproval();
    const version = (
      await one<{ version: number }>('SELECT version FROM approvals WHERE id = $1', [
        pending.approvalId,
      ])
    ).version;

    const response = await call(
      `${pending.approvalId}/withdraw`,
      { reason: 'Edital precisa de nova análise de riscos' },
      { subject: 'sub-marta-us135', ifMatch: `"${String(version)}"` },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      (await linesOf(pending.approvalId)).map((line) => [
        line.sequence,
        line.status,
        line.decision,
      ]),
    ).toEqual([
      [1, 'APPROVED', 'APPROVE'],
      [2, 'CANCELED', null],
    ]);
    expect(
      await db.admin<Row>(
        `SELECT status::text, cancellation_reason::text, canceled_by_id FROM approvals WHERE id = $1`,
        [pending.approvalId],
      ),
    ).toEqual([{ status: 'CANCELED', cancellation_reason: 'WITHDRAWN', canceled_by_id: MARTA }]);
    expect(
      await db.admin<Row>('SELECT status::text FROM processes WHERE id = $1', [pending.processId]),
    ).toEqual([{ status: 'RETURNED' }]);
    expect(
      (await approverAccess(pending.processId)).filter((row) => row.user_id === MARCELO),
    ).toEqual([expect.objectContaining({ revoked: true })]);
    const [audit] = await db.admin<{ metadata: Row }>(
      `SELECT metadata FROM audit_logs WHERE process_id = $1 AND action = 'approval.withdraw'`,
      [pending.processId],
    );
    expect(audit?.metadata).toMatchObject({ actorRole: 'MANAGER', linesCanceled: 1, votesKept: 1 });
  });

  it('[Concorrência] decisão × redirecionamento da mesma linha e dois redirecionamentos: uma só linha viva', async () => {
    const raced = await votedApproval();
    const line = await liveLine(raced.approvalId, 2);
    const ifMatch = `"${String(line.version)}"`;

    const [vote, moved] = await Promise.all([
      call(
        `${raced.approvalId}/decide`,
        { decision: 'APPROVE', approvalApproverId: line.id },
        { subject: 'sub-marcelo-us135', ifMatch },
      ),
      reassign(raced.approvalId, line.id, PAULA, { ifMatch }),
    ]);
    expect([vote.status, moved.status].sort()).toEqual([200, 409]);
    const loser = vote.status === 409 ? vote : moved;
    expect(codeOf(loser)).toBe('APPROVAL_LINE_NOT_PENDING');
    const live = (await linesOf(raced.approvalId)).filter(
      (candidate) => candidate.sequence === 2 && candidate.status !== 'CANCELED',
    );
    expect(live).toHaveLength(1);

    const twice = await votedApproval();
    const target = await liveLine(twice.approvalId, 2);
    const both = await Promise.all([
      reassign(twice.approvalId, target.id, PAULA, { ifMatch: `"${String(target.version)}"` }),
      reassign(twice.approvalId, target.id, DIEGO, { ifMatch: `"${String(target.version)}"` }),
    ]);
    expect(both.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = both.find((response) => response.status === 409);
    if (!rejected) throw new Error('sem resposta 409');
    expect(codeOf(rejected)).toBe('APPROVAL_LINE_NOT_PENDING');
    expect((await linesOf(twice.approvalId)).filter((row) => row.sequence === 2)).toHaveLength(2);
  });

  it('[Duplicidade] a mesma Idempotency-Key em paralelo grava um único redirecionamento', async () => {
    const pending = await votedApproval();
    const line = await liveLine(pending.approvalId, 2);
    const key = randomUUID();
    const options = { key, ifMatch: `"${String(line.version)}"` };

    const responses = await Promise.all([
      reassign(pending.approvalId, line.id, PAULA, options),
      reassign(pending.approvalId, line.id, PAULA, options),
    ]);

    expect(responses.some((response) => response.status === 200)).toBe(true);
    for (const response of responses) expect([200, 409]).toContain(response.status);
    expect((await linesOf(pending.approvalId)).filter((row) => row.sequence === 2)).toHaveLength(2);
    const events = await db.admin<Row>(
      `SELECT id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ApprovalReassigned'`,
      [pending.approvalId],
    );
    expect(events).toHaveLength(1);
  });

  it('[Tenant incorreto] a aprovação de A não existe para B (404), o aprovador de B não é elegível em A (422) e a RLS esconde as linhas', async () => {
    const pending = await votedApproval();
    const line = await liveLine(pending.approvalId, 2);
    const ifMatch = `"${String(line.version)}"`;

    const foreign = await reassign(pending.approvalId, line.id, PAULA, {
      subject: 'sub-beto-us135',
      tenant: B,
      ifMatch,
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(codeOf(foreign)).toBe('APPROVAL_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('Marcelo');

    const outsider = await reassign(pending.approvalId, line.id, BETO, { ifMatch });
    expect(outsider.status, JSON.stringify(outsider.body)).toBe(422);
    expect(codeOf(outsider)).toBe('APPROVER_NOT_ELIGIBLE');

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<
              Row[]
            >`SELECT id FROM approval_approvers WHERE approval_id = ${pending.approvalId}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
      const touched = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE approval_approvers SET status = 'CANCELED', skipped_reason = 'REASSIGNED'
                WHERE approval_id = ${pending.approvalId}::uuid AND sequence = 2`,
        ),
      );
      expect(touched).toBe(0);
    } finally {
      await client.$disconnect();
    }
    expect((await liveLine(pending.approvalId, 2)).approver_user_id).toBe(MARCELO);
  });
});
