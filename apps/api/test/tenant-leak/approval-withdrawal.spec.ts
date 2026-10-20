// Retirar ou redirecionar aprovação pendente sobre PostgreSQL real (US-053 · Sucesso, Tenant
// incorreto, Concorrência, Falha de banco e Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais do provisionamento (workflow padrão DEC-015 — APROVACAO_DFD com a titular
// da secretaria solicitante e o substituto). Prova que a retirada aplica de uma vez a aprovação
// cancelada (`WITHDRAWN`), o documento, a devolução (`RETURN` com `metadata.withdrawn`), timeline,
// auditoria e outbox — e que uma falha induzida DEPOIS da aprovação cancelada desfaz tudo; que o
// redirecionamento troca o `ProcessAccess` `APPROVER` na mesma transação e deixa o
// `ApprovalReassigned` `PENDING` no outbox (sem o motivo); que retirada e decisão simultâneas têm um
// único vencedor; e que a aprovação de A não existe para o tenant B (404).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  ForwardedProcessDto,
  ProcessDto,
  WithdrawnApprovalDto,
} from '@contrataflow/validation';
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

const A = '0192c053-0000-7000-8000-00000000010a';
const B = '0192c053-0000-7000-8000-00000000010b';
const ORG_A = '0192c053-0000-7000-8000-0000000010a0';
const ORG_B = '0192c053-0000-7000-8000-0000000010b0';
const OBRAS = '0192c053-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c053-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c053-0000-7000-8000-0000000010b1';
const ANA = '0192c053-0000-7000-8000-0000000010c1';
const CARLA = '0192c053-0000-7000-8000-0000000010c2';
const DIEGO = '0192c053-0000-7000-8000-0000000010c3';
const BETO = '0192c053-0000-7000-8000-0000000010c6';
const ANA_M = '0192c053-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const REASON = 'Encaminhado antes da revisão final do DFD.';
const LEAVE = 'Carla está de licença médica';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['AUTORIDADE_COMPETENTE'],
  [DIEGO]: ['AUTORIDADE_COMPETENTE'],
  [BETO]: ['AUTORIDADE_COMPETENTE'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us053', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us053', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us053', 'ana@a.test', true, 'Ana Requisitante'),
  ('${CARLA}', 'sub-carla-us053', 'carla@a.test', true, 'Carla Titular'),
  ('${DIEGO}', 'sub-diego-us053', 'diego@a.test', true, 'Diego Substituto'),
  ('${BETO}', 'sub-beto-us053', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${CARLA}', '${DIEGO}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, '${BETO}', NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c053-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c053-0000-7000-8000-0000000010d3', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c053-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c053-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c053-0000-7000-8000-0000000010e2', '${A}', '0192c053-0000-7000-8000-0000000010d2', '${OBRAS}', true);
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

describe('Feature: Retirar ou redirecionar aprovação sobre PostgreSQL (US-053)', () => {
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
      .set('Authorization', api.bearer(options.subject ?? 'sub-carla-us053', { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('If-Match', `"${String(options.version ?? 1)}"`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const post = (
    route: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; version?: number },
    subject: string,
  ) =>
    request(api.server)
      .post(route)
      .set('Authorization', api.bearer(options.subject ?? subject, { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('If-Match', `"${String(options.version ?? 1)}"`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const withdraw = (
    approvalId: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; version?: number } = {},
  ) => post(`/api/v1/approvals/${approvalId}/withdraw`, body, options, 'sub-ana-us053');
  const reassign = (
    approvalId: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; version?: number } = {},
  ) => post(`/api/v1/approvals/${approvalId}/reassign`, body, options, 'sub-carla-us053');
  /** Concessões `APPROVER` ativas da aprovação (troca limpa — RN-TRAM-70). */
  const approverGrants = async (processId: string, approvalId: string) =>
    (
      await db.admin<{ user_id: string }>(
        `SELECT user_id FROM process_access WHERE process_id = $1 AND reason = 'APPROVER'
            AND source_id = $2 AND revoked_at IS NULL ORDER BY user_id`,
        [processId, approvalId],
      )
    ).map((row) => row.user_id);

  /** Processo na ABERTURA com o DFD finalizado (v1), encaminhado à APROVACAO_DFD (Carla). */
  async function pendingDfdApproval(): Promise<Pending> {
    const created = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us053', { amr: MFA }))
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
    // Snapshot mínimo e válido: a decisão lê a versão analisada (`documentSnapshotSchema`).
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
      .set('Authorization', api.bearer('sub-ana-us053', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.currentStage?.id, transitionId });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approvalId = (forwarded.body as { data: ForwardedProcessDto }).data.approval?.id ?? '';
    return { processId: process.id, approvalId, documentId, versionId };
  }

  /** Tudo que a retirada/o redirecionamento gravam — para provar o rollback. */
  const effects = async (processId: string) => ({
    process: await db.admin<Row>(
      'SELECT status::text, version, current_stage_id, current_responsible_id FROM processes WHERE id = $1',
      [processId],
    ),
    stages: await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [processId],
    ),
    movements: await db.admin<Row>(
      `SELECT sequence, action::text, metadata->>'withdrawn' AS withdrawn, approval_id, comment
         FROM process_movements WHERE process_id = $1 ORDER BY sequence`,
      [processId],
    ),
    approvals: await db.admin<Row>(
      `SELECT id, status::text, cancellation_reason, canceled_by_id, approver_user_id, version
         FROM approvals WHERE process_id = $1 ORDER BY created_at`,
      [processId],
    ),
    documents: await db.admin<Row>(
      `SELECT id, status::text, pending_approval_id FROM documents
        WHERE process_id = $1 ORDER BY id`,
      [processId],
    ),
    access: await db.admin<Row>(
      `SELECT user_id, reason::text, revoked_at FROM process_access
        WHERE process_id = $1 AND reason = 'APPROVER' ORDER BY user_id`,
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

  it('[Falha de banco] falha induzida na tramitação (depois da aprovação cancelada) desfaz tudo; sem ela, a retirada devolve o processo à abertura', async () => {
    const pending = await pendingDfdApproval();
    await db.admin(`
      CREATE FUNCTION test_fail_process_movements() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'falha induzida no teste'; END $fn$;
      CREATE TRIGGER test_fail_process_movements BEFORE INSERT ON process_movements
        FOR EACH ROW EXECUTE FUNCTION test_fail_process_movements();`);
    try {
      const before = await effects(pending.processId);
      const failed = await withdraw(pending.approvalId, { reason: REASON });
      expect(failed.status).toBe(500);
      expect(await effects(pending.processId)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_process_movements ON process_movements; DROP FUNCTION test_fail_process_movements();',
      );
    }

    // [Sucesso] A retirada devolve o processo à abertura (RETURNED).
    const ok = await withdraw(pending.approvalId, { reason: REASON });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as { data: WithdrawnApprovalDto }).data).toMatchObject({
      status: 'CANCELED',
      processStatus: 'RETURNED',
      version: 2,
    });
    const after = await effects(pending.processId);
    expect(after.approvals).toEqual([
      {
        id: pending.approvalId,
        status: 'CANCELED',
        cancellation_reason: 'WITHDRAWN',
        canceled_by_id: ANA,
        approver_user_id: CARLA,
        version: 2,
      },
    ]);
    expect(after.documents).toEqual([
      { id: pending.documentId, status: 'FINALIZED', pending_approval_id: null },
    ]);
    // Ana encaminhou; o responsável anterior elegível (RN-TRAM-28) é provado no teste em memória —
    // aqui os perfis vêm só do token (sem atribuição no banco), então a passagem fica na fila.
    expect(after.process[0]).toMatchObject({ status: 'RETURNED' });
    expect(after.movements.at(-1)).toEqual({
      sequence: 3,
      action: 'RETURN',
      withdrawn: 'true',
      approval_id: pending.approvalId,
      comment: REASON,
    });
    expect(after.timeline.map((row) => row.type)).toEqual(
      expect.arrayContaining(['APPROVAL_CANCELED', 'PROCESS_RETURNED']),
    );
    expect(after.audit.map((row) => row.action)).toContain('approval.withdraw');
    expect(after.events).toEqual(
      expect.arrayContaining([
        { event_type: 'ApprovalCanceled', routing_key: 'approval.canceled', status: 'PENDING' },
        {
          event_type: 'ProcessStageChanged',
          routing_key: 'process.stage_changed.return',
          status: 'PENDING',
        },
      ]),
    );
  });

  it('[Falha de integração] redirecionamento: 200, ApprovalReassigned PENDING no outbox e a troca do APPROVER na mesma transação', async () => {
    const pending = await pendingDfdApproval();
    expect((await approverGrants(pending.processId, pending.approvalId)).sort()).toEqual(
      [CARLA, DIEGO].sort(),
    );

    const response = await reassign(pending.approvalId, {
      approverType: 'USER',
      targetApproverUserId: DIEGO,
      reason: LEAVE,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await effects(pending.processId);
    expect(after.approvals[0]).toMatchObject({
      status: 'PENDING',
      approver_user_id: DIEGO,
      version: 2,
    });
    expect(after.events).toEqual(
      expect.arrayContaining([
        {
          event_type: 'ApprovalReassigned',
          routing_key: 'approval.reassigned',
          status: 'PENDING',
        },
      ]),
    );
    expect(after.timeline.map((row) => row.type)).toContain('APPROVAL_REASSIGNED');
    expect(after.audit.map((row) => row.action)).toContain('approval.reassign');
    expect(await approverGrants(pending.processId, pending.approvalId)).toEqual([DIEGO]);
    const payload = await one<{ payload: string }>(
      "SELECT payload::text FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ApprovalReassigned'",
      [pending.approvalId],
    );
    expect(payload.payload).not.toContain(LEAVE);
  });

  it('[Concorrência] retirada e decisão ao mesmo tempo: exatamente uma vence', async () => {
    const pending = await pendingDfdApproval();

    const results = await Promise.all([
      withdraw(pending.approvalId),
      decide(pending.approvalId, { decision: 'APPROVE' }),
    ]);

    const statuses = results.map((response) => response.status).sort();
    expect(statuses[0]).toBe(200);
    expect([409, 412]).toContain(statuses[1]);
    const loser = results.find((response) => response.status !== 200);
    expect(['APPROVAL_NOT_PENDING', 'VERSION_CONFLICT']).toContain(
      problemDetailsSchema.parse(loser?.body).code,
    );
    const after = await effects(pending.processId);
    const actions = after.audit
      .map((row) => row.action)
      .filter((action) => action === 'approval.withdraw' || action === 'approval.decide');
    expect(actions).toHaveLength(1);
    expect(after.movements.filter((row) => row.sequence === 3)).toHaveLength(1);
  });

  it('[Tenant incorreto] a aprovação de A não existe para o tenant B: 404 na retirada e no redirecionamento', async () => {
    const pending = await pendingDfdApproval();
    const before = await effects(pending.processId);

    const withdrawn = await withdraw(
      pending.approvalId,
      {},
      { subject: 'sub-beto-us053', tenant: B },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(404);
    expect(problemDetailsSchema.parse(withdrawn.body).code).toBe('APPROVAL_NOT_FOUND');
    const reassigned = await reassign(
      pending.approvalId,
      { approverType: 'USER', targetApproverUserId: BETO, reason: LEAVE },
      { subject: 'sub-beto-us053', tenant: B },
    );
    expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(404);
    expect(problemDetailsSchema.parse(reassigned.body).code).toBe('APPROVAL_NOT_FOUND');
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
