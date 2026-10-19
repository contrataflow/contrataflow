// Decisão de aprovação sobre PostgreSQL real (US-052 · Sucesso, Tenant incorreto, Concorrência e
// Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento
// (workflow padrão DEC-015 — APROVACAO_DFD com o titular da secretaria solicitante e o substituto).
// Prova que a decisão aplica de uma vez aprovação, documento (DEC-018), selo `APPROVAL_STAMPED`
// `PENDING`, mudança de etapa/status, tramitação, timeline, auditoria e outbox; que uma falha
// induzida DEPOIS das primeiras escritas desfaz tudo (nenhum efeito parcial); que titular e
// substituto disputando a mesma aprovação resultam numa única decisão; e que a aprovação de A não
// existe para o tenant B (404 e RLS). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DecidedApprovalDto, ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
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

const A = '0192c052-0000-7000-8000-00000000010a';
const B = '0192c052-0000-7000-8000-00000000010b';
const ORG_A = '0192c052-0000-7000-8000-0000000010a0';
const ORG_B = '0192c052-0000-7000-8000-0000000010b0';
const OBRAS = '0192c052-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c052-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c052-0000-7000-8000-0000000010b1';
const ANA = '0192c052-0000-7000-8000-0000000010c1';
const CARLA = '0192c052-0000-7000-8000-0000000010c2';
const DIEGO = '0192c052-0000-7000-8000-0000000010c3';
const BETO = '0192c052-0000-7000-8000-0000000010c6';
const ANA_M = '0192c052-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const COMMENT = 'A demanda não se enquadra no planejamento anual.';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['AUTORIDADE_COMPETENTE'],
  [DIEGO]: ['AUTORIDADE_COMPETENTE'],
  [BETO]: ['AUTORIDADE_COMPETENTE'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us052', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us052', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us052', 'ana@a.test', true, 'Ana Requisitante'),
  ('${CARLA}', 'sub-carla-us052', 'carla@a.test', true, 'Carla Titular'),
  ('${DIEGO}', 'sub-diego-us052', 'diego@a.test', true, 'Diego Substituto'),
  ('${BETO}', 'sub-beto-us052', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${CARLA}', '${DIEGO}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, '${BETO}', NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c052-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c052-0000-7000-8000-0000000010d3', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c052-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c052-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

interface Pending {
  readonly processId: string;
  readonly approvalId: string;
  readonly documentId: string;
  readonly versionId: string;
}

describe('Feature: Decidir aprovação sobre PostgreSQL (US-052)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let facts: TestDocumentFacts;
  let catalog: { contractingType: string; origin: string };

  const one = async <T extends Row>(sql: string, params: unknown[]): Promise<T> => {
    const [row] = await db.admin<T>(sql, params);
    if (!row) throw new Error(`sem linha: ${sql}`);
    return row;
  };
  const decide = (
    approvalId: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; version?: number } = {},
  ) =>
    request(api.server)
      .post(`/api/v1/approvals/${approvalId}/decide`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-carla-us052', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('If-Match', `"${String(options.version ?? 1)}"`)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  /** Processo na ABERTURA com o DFD finalizado (v1), encaminhado à APROVACAO_DFD (Carla). */
  async function pendingDfdApproval(): Promise<Pending> {
    const created = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us052', { amr: MFA }))
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
    await db.admin(`
      BEGIN;
      INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, singleton_key,
        current_version_id, finalized_at, finalized_by_id, created_by_id)
      VALUES ('${documentId}', '${A}', '${process.id}', '${type}', 'DFD da manutenção', 'FINALIZED',
        '${type}', '${versionId}', now(), '${ANA}', '${ANA}');
      INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number, reason,
        status_at_creation, content, content_hash, created_by_id)
      VALUES ('${versionId}', '${A}', '${documentId}', '${process.id}', 1, 'FINALIZATION', 'FINALIZED',
        '{}'::jsonb, '${'d'.repeat(64)}', '${ANA}');
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
      .set('Authorization', api.bearer('sub-ana-us052', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.currentStage?.id, transitionId });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approvalId = (forwarded.body as { data: ForwardedProcessDto }).data.approval?.id ?? '';
    return { processId: process.id, approvalId, documentId, versionId };
  }

  /** Tudo que a decisão grava — para provar o rollback. */
  const effects = async (processId: string) => ({
    process: await db.admin<Row>(
      'SELECT status::text, version, current_stage_id, completed_at FROM processes WHERE id = $1',
      [processId],
    ),
    stages: await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [processId],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence, action::text FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [processId],
    ),
    approvals: await db.admin<Row>(
      `SELECT id, status::text, decision::text, decided_by_id, decided_as_deputy, version
         FROM approvals WHERE process_id = $1 ORDER BY created_at`,
      [processId],
    ),
    documents: await db.admin<Row>(
      `SELECT id, status::text, pending_approval_id, approved_version_id FROM documents
        WHERE process_id = $1 ORDER BY id`,
      [processId],
    ),
    renditions: await db.admin<Row>(
      `SELECT kind::text, status::text, approval_id, document_version_id FROM document_renditions
        WHERE process_id = $1 ORDER BY kind`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      'SELECT type::text FROM process_timeline_entries WHERE process_id = $1 ORDER BY type',
      [processId],
    ),
    audit: await db.admin<Row>(
      'SELECT action FROM audit_logs WHERE process_id = $1 ORDER BY action',
      [processId],
    ),
    events: await db.admin<Row>(
      'SELECT event_type, routing_key, status::text FROM outbox_events WHERE process_id = $1 ORDER BY event_type, routing_key',
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Falha de banco] falha induzida no selo (depois da decisão e do documento) desfaz tudo; sem ela, a decisão completa', async () => {
    const pending = await pendingDfdApproval();
    await db.admin(`
      CREATE FUNCTION test_fail_document_renditions() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'falha induzida no teste'; END $fn$;
      CREATE TRIGGER test_fail_document_renditions BEFORE INSERT ON document_renditions
        FOR EACH ROW EXECUTE FUNCTION test_fail_document_renditions();`);
    try {
      const before = await effects(pending.processId);
      const failed = await decide(pending.approvalId, { decision: 'APPROVE' });
      expect(failed.status).toBe(500);
      expect(await effects(pending.processId)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_document_renditions ON document_renditions; DROP FUNCTION test_fail_document_renditions();',
      );
    }

    // [Sucesso] Aprovar leva o processo à próxima etapa (ESTUDOS_PRELIMINARES, IN_PROGRESS).
    const ok = await decide(pending.approvalId, { decision: 'APPROVE' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as { data: DecidedApprovalDto }).data).toMatchObject({
      status: 'APPROVED',
      processStage: { key: 'ESTUDOS_PRELIMINARES' },
      processStatus: 'IN_PROGRESS',
      version: 2,
    });
    const after = await effects(pending.processId);
    expect(after.approvals).toEqual([
      {
        id: pending.approvalId,
        status: 'APPROVED',
        decision: 'APPROVE',
        decided_by_id: CARLA,
        decided_as_deputy: false,
        version: 2,
      },
    ]);
    expect(after.documents).toEqual([
      {
        id: pending.documentId,
        status: 'APPROVED',
        pending_approval_id: null,
        approved_version_id: pending.versionId,
      },
    ]);
    expect(after.renditions).toEqual([
      {
        kind: 'APPROVAL_STAMPED',
        status: 'PENDING',
        approval_id: pending.approvalId,
        document_version_id: pending.versionId,
      },
    ]);
    expect(after.process[0]).toMatchObject({ status: 'IN_PROGRESS' });
    expect(after.movements.at(-1)).toEqual({ sequence: 3, action: 'APPROVE' });
    expect(after.timeline.map((row) => row.type)).toEqual(
      expect.arrayContaining(['APPROVAL_DECIDED', 'PROCESS_STAGE_CHANGED']),
    );
    expect(after.audit.map((row) => row.action)).toContain('approval.decide');
    expect(after.events).toEqual(
      expect.arrayContaining([
        { event_type: 'ApprovalCompleted', routing_key: 'approval.completed', status: 'PENDING' },
        {
          event_type: 'ProcessStageChanged',
          routing_key: 'process.stage_changed.approval_approved',
          status: 'PENDING',
        },
        {
          event_type: 'ProcessStatusChanged',
          routing_key: 'process.status_changed.in_progress',
          status: 'PENDING',
        },
      ]),
    );
  });

  it('[FA-04] Indeferir: documento REJECTED e o processo volta à abertura como RETURNED', async () => {
    const pending = await pendingDfdApproval();

    const response = await decide(pending.approvalId, { decision: 'REJECT', comment: COMMENT });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await effects(pending.processId);
    expect(after.documents[0]).toMatchObject({ status: 'REJECTED', pending_approval_id: null });
    expect(after.process[0]).toMatchObject({ status: 'RETURNED' });
    expect(after.renditions).toEqual([]);
    const comment = await one<{ decision_comment: string }>(
      'SELECT decision_comment FROM approvals WHERE id = $1',
      [pending.approvalId],
    );
    expect(comment.decision_comment).toBe(COMMENT);
  });

  it('[Concorrência] titular e substituto ao mesmo tempo: uma decisão aplicada, a outra 409/412', async () => {
    const pending = await pendingDfdApproval();

    const results = await Promise.all([
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us052' }),
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-diego-us052' }),
    ]);

    const statuses = results.map((response) => response.status).sort();
    expect(statuses[0]).toBe(200);
    expect([409, 412]).toContain(statuses[1]);
    const loser = results.find((response) => response.status !== 200);
    expect(['APPROVAL_NOT_PENDING', 'VERSION_CONFLICT']).toContain(
      problemDetailsSchema.parse(loser?.body).code,
    );
    const after = await effects(pending.processId);
    expect(after.movements.filter((row) => row.action === 'APPROVE')).toHaveLength(1);
    expect(after.audit.filter((row) => row.action === 'approval.decide')).toHaveLength(1);
    expect(after.renditions).toHaveLength(1);
  });

  it('[Tenant incorreto] a aprovação de A não existe para o tenant B: 404 no detalhe e na decisão, e a RLS a esconde', async () => {
    const pending = await pendingDfdApproval();
    const before = await effects(pending.processId);

    const detail = await request(api.server)
      .get(`/api/v1/approvals/${pending.approvalId}`)
      .set('Authorization', api.bearer('sub-beto-us052', { amr: MFA }))
      .set('X-Tenant-Id', B);
    expect(detail.status, JSON.stringify(detail.body)).toBe(404);
    expect(problemDetailsSchema.parse(detail.body).code).toBe('APPROVAL_NOT_FOUND');
    const decision = await decide(
      pending.approvalId,
      { decision: 'APPROVE' },
      { subject: 'sub-beto-us052', tenant: B },
    );
    expect(decision.status, JSON.stringify(decision.body)).toBe(404);
    expect(problemDetailsSchema.parse(decision.body).code).toBe('APPROVAL_NOT_FOUND');
    expect(await effects(pending.processId)).toEqual(before);

    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<Row[]>`SELECT id FROM approvals WHERE id = ${pending.approvalId}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
