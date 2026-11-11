// Aprovação múltipla sobre PostgreSQL real (US-133 · M2-02/M2-03 · Sucesso, Validação, Tenant
// incorreto, Concorrência, Falha de banco e Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais do provisionamento e a etapa APROVACAO_DFD do workflow padrão configurada
// com a política `ALL` (1. titular da secretaria solicitante, 2. o usuário "Marcelo"). Prova que as
// linhas, o espelho, as concessões `APPROVER` por linha e o outbox são gravados na transação do
// encaminhamento; que `APPROVER_DUPLICATED`, `SELF_APPROVAL_FORBIDDEN` e uma falha induzida ao
// gravar a 2ª linha desfazem tudo; que as linhas de A não existem para B (RLS + FK composta); o
// índice único parcial e os checks da tabela; a corrida sem linha órfã; e o backfill M2-03
// (2.350 aprovações, idempotente, reconciliação por status e divergência abortando a migração).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PendingApprovalExistsError } from '#modules/approval/application/ports.js';
import type { ApprovalApprover } from '#modules/approval/domain/approval-lines.js';
import type { Approval } from '#modules/approval/domain/approval.js';
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

const A = '0192c133-0000-7000-8000-00000000010a';
const B = '0192c133-0000-7000-8000-00000000010b';
const ORG_A = '0192c133-0000-7000-8000-0000000010a0';
const ORG_B = '0192c133-0000-7000-8000-0000000010b0';
const OBRAS = '0192c133-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c133-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c133-0000-7000-8000-0000000010b1';
const ANA = '0192c133-0000-7000-8000-0000000010c1';
const MARTA = '0192c133-0000-7000-8000-0000000010c2';
const DAVI = '0192c133-0000-7000-8000-0000000010c3';
const MARCELO = '0192c133-0000-7000-8000-0000000010c4';
const BETO = '0192c133-0000-7000-8000-0000000010c6';
const ANA_M = '0192c133-0000-7000-8000-0000000010d1';
const BETO_M = '0192c133-0000-7000-8000-0000000010d6';
const NOW = new Date('2026-11-11T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const BACKFILL_SQL = readFileSync(
  new URL(
    '../../prisma/migrations/20261112091000_approval_approvers_backfill/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us133', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us133', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us133', 'ana@a.test', true, 'Carla Mendes'),
  ('${MARTA}', 'sub-marta-us133', 'marta@a.test', true, 'Roberto Lima'),
  ('${DAVI}', 'sub-davi-us133', 'davi@a.test', true, 'Helena Prado'),
  ('${MARCELO}', 'sub-marcelo-us133', 'marcelo@a.test', true, 'Marcos Alves'),
  ('${BETO}', 'sub-beto-us133', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${MARTA}', '${DAVI}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c133-0000-7000-8000-0000000010d2', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c133-0000-7000-8000-0000000010d3', '${A}', '${DAVI}', 'INTERNAL', 'ACTIVE'),
  ('0192c133-0000-7000-8000-0000000010d4', '${A}', '${MARCELO}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c133-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

/** RN-APV-16: a etapa APROVACAO_DFD do workflow padrão de A com `ALL` e duas linhas (US-132). */
const STAGE_LINES = JSON.stringify({
  decisionPolicy: 'ALL',
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
      label: 'Prefeito',
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

interface Target {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Aprovação múltipla sobre PostgreSQL (US-133)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let facts: TestDocumentFacts;
  let catalog: { contractingType: string; origin: string };

  const forward = (process: Target, transitionId: string) =>
    request(api.server)
      .post(`/api/v1/processes/${process.id}/forward`)
      .set('Authorization', api.bearer('sub-ana-us133', { amr: MFA }))
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

  /** PRC-02 (Ana, na ABERTURA do workflow padrão). */
  async function createProcess(): Promise<Target> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us133', { amr: MFA }))
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

  /** DFD finalizado (v1) criado por `authorId` — a cobertura de APROVACAO_DFD. */
  async function finalizedDfd(processId: string, authorId: string = ANA): Promise<void> {
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DFD'",
      [A],
    );
    const documentId = randomUUID();
    const versionId = randomUUID();
    await db.admin(`
      BEGIN;
      INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status, singleton_key,
        current_version_id, finalized_at, finalized_by_id, created_by_id)
      VALUES ('${documentId}', '${A}', '${processId}', '${type?.id ?? ''}', 'DFD da manutenção',
        'FINALIZED', '${type?.id ?? ''}', '${versionId}', now(), '${authorId}', '${authorId}');
      INSERT INTO document_versions (id, tenant_id, document_id, process_id, version_number, reason,
        status_at_creation, content, content_hash, created_by_id)
      VALUES ('${versionId}', '${A}', '${documentId}', '${processId}', 1, 'FINALIZATION', 'FINALIZED',
        '{}'::jsonb, '${'d'.repeat(64)}', '${authorId}');
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
  }

  /** Tudo que a solicitação (e o encaminhamento) gravam — para provar o rollback. */
  const effects = async (id: string) => ({
    process: await db.admin<Row>(
      'SELECT status::text, version, current_stage_id FROM processes WHERE id = $1',
      [id],
    ),
    stages: await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    approvals: await db.admin<Row>('SELECT id FROM approvals WHERE process_id = $1', [id]),
    lines: await db.admin<Row>(
      `SELECT l.id FROM approval_approvers l
         JOIN approvals a ON a.tenant_id = l.tenant_id AND a.id = l.approval_id
        WHERE a.process_id = $1`,
      [id],
    ),
    documents: await db.admin<Row>(
      'SELECT id, status::text, pending_approval_id FROM documents WHERE process_id = $1 ORDER BY id',
      [id],
    ),
    access: await db.admin<Row>(
      `SELECT reason::text, user_id, source_id FROM process_access
        WHERE process_id = $1 AND reason = 'APPROVER' ORDER BY user_id`,
      [id],
    ),
    timeline: await db.admin<Row>(
      "SELECT type::text FROM process_timeline_entries WHERE process_id = $1 AND type = 'APPROVAL_REQUESTED'",
      [id],
    ),
    events: await db.admin<Row>(
      "SELECT event_type FROM outbox_events WHERE process_id = $1 AND event_type = 'ApprovalRequested'",
      [id],
    ),
  });

  const repository = new PrismaApprovalRepository();
  const approvalOn = (stageId: string, processId: string, approvalId = randomUUID()): Approval => ({
    id: approvalId,
    tenantId: A,
    processId,
    subjectType: 'PROCESS_STAGE',
    processStageId: stageId,
    documentId: null,
    title: 'Aprovação com linhas',
    requestedById: ANA,
    requestedAt: NOW,
    requestComment: null,
    approverType: 'USER',
    approverUserId: MARTA,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    dueAt: null,
    status: 'PENDING',
    createdAt: NOW,
    createdById: ANA,
    decisionPolicy: 'ALL',
  });
  const lineOf = (
    approvalId: string,
    sequence: number,
    overrides: Partial<ApprovalApprover> = {},
  ): ApprovalApprover => ({
    id: randomUUID(),
    approvalId,
    sequence,
    approverType: 'USER',
    approverUserId: sequence === 1 ? MARTA : MARCELO,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    status: 'PENDING',
    activatedAt: NOW,
    dueAt: null,
    decision: null,
    decidedById: null,
    decidedAt: null,
    decisionComment: null,
    decidedAsDeputy: false,
    reassignedFromId: null,
    skippedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: ANA,
    version: 1,
    ...overrides,
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
    // A etapa publicada recebe a política e as linhas no snapshot (o que o motor lê), antes de
    // qualquer leitura — só o teste contorna a imutabilidade (`session_replication_role`).
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

  it('[Sucesso]/[Falha de integração] ALL: aprovação, linhas PENDING, APPROVER por linha e ApprovalRequested PENDING no outbox, na transação do encaminhamento', async () => {
    const process = await createProcess();
    await finalizedDfd(process.id);
    const response = await forward(process, await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD'));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const approval = (response.body as { data: ForwardedProcessDto }).data.approval;
    expect(approval).toMatchObject({
      decisionPolicy: 'ALL',
      approverLabel: 'Roberto Lima (titular da Secretaria de Obras) e Marcos Alves',
    });
    const approvalId = approval?.id ?? '';
    expect(
      await db.admin(
        'SELECT decision_policy::text, approver_type::text, approver_user_id FROM approvals WHERE id = $1',
        [approvalId],
      ),
    ).toEqual([
      { decision_policy: 'ALL', approver_type: 'DEPARTMENT_HEAD', approver_user_id: MARTA },
    ]);
    const lines = await db.admin<{ id: string }>(
      `SELECT id, sequence, status::text, approver_type::text, approver_user_id, allow_deputy,
              activated_at IS NOT NULL AS activated, created_by_id
         FROM approval_approvers WHERE approval_id = $1 ORDER BY sequence`,
      [approvalId],
    );
    expect(lines).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'PENDING',
        approver_type: 'DEPARTMENT_HEAD',
        approver_user_id: MARTA,
        allow_deputy: true,
        activated: true,
        created_by_id: ANA,
      }),
      expect.objectContaining({
        sequence: 2,
        status: 'PENDING',
        approver_type: 'USER',
        approver_user_id: MARCELO,
        allow_deputy: false,
        activated: true,
      }),
    ]);
    // RN-APV-25: titular e substituto pela linha 1, Marcelo pela linha 2 (`sourceId` = linha).
    expect((await effects(process.id)).access).toEqual(
      [
        { reason: 'APPROVER', user_id: MARTA, source_id: lines[0]?.id },
        { reason: 'APPROVER', user_id: DAVI, source_id: lines[0]?.id },
        { reason: 'APPROVER', user_id: MARCELO, source_id: lines[1]?.id },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    // O relay não roda no teste: o evento fica PENDING no outbox (publicado depois — US-082).
    const [event] = await db.admin<{ status: string; payload: Row }>(
      `SELECT status::text, payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'ApprovalRequested'`,
      [approvalId],
    );
    expect(event?.status).toBe('PENDING');
    expect(event?.payload).toMatchObject({
      decisionPolicy: 'ALL',
      approvers: [
        { approvalApproverId: lines[0]?.id, sequence: 1, status: 'PENDING' },
        { approvalApproverId: lines[1]?.id, sequence: 2, status: 'PENDING' },
      ],
    });
    expect(JSON.stringify(event?.payload)).not.toContain('Marcos');

    // [Tenant incorreto] RLS: B não enxerga as linhas de A; nem grava linha na aprovação de A.
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<
              Row[]
            >`SELECT id FROM approval_approvers WHERE approval_id = ${approvalId}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
      await expect(
        asTenant(B, () =>
          client.$tenantTransaction(
            (tx) =>
              tx.$executeRaw`INSERT INTO approval_approvers (id, tenant_id, approval_id, sequence,
                approver_type, approver_user_id, allow_deputy, status, activated_at)
              VALUES (${randomUUID()}::uuid, ${A}::uuid, ${approvalId}::uuid, 3, 'USER', ${BETO}::uuid,
                false, 'PENDING', now())`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        asTenant(B, () =>
          client.$tenantTransaction(
            (tx) =>
              tx.$executeRaw`INSERT INTO approval_approvers (id, tenant_id, approval_id, sequence,
                approver_type, approver_user_id, allow_deputy, status, activated_at)
              VALUES (${randomUUID()}::uuid, ${B}::uuid, ${approvalId}::uuid, 3, 'USER', ${BETO}::uuid,
                false, 'PENDING', now())`,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await client.$disconnect();
    }
    expect(
      await db.admin('SELECT id FROM approval_approvers WHERE approval_id = $1', [approvalId]),
    ).toHaveLength(2);
  });

  it('[Sucesso] titular autor do DFD: a linha 1 vai para o substituto (allowDeputy falso) e a auditoria registra selfApprovalAvoided', async () => {
    const process = await createProcess();
    await finalizedDfd(process.id, MARTA);
    const response = await forward(process, await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD'));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const approvalId = (response.body as { data: ForwardedProcessDto }).data.approval?.id ?? '';
    expect(
      await db.admin(
        `SELECT approver_type::text, approver_user_id, allow_deputy FROM approval_approvers
          WHERE approval_id = $1 AND sequence = 1`,
        [approvalId],
      ),
    ).toEqual([{ approver_type: 'DEPARTMENT_HEAD', approver_user_id: DAVI, allow_deputy: false }]);
    const [audit] = await db.admin<{ metadata: Row }>(
      "SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'approval.request'",
      [approvalId],
    );
    expect(audit?.metadata).toMatchObject({
      decisionPolicy: 'ALL',
      approversCount: 2,
      lines: [{ sequence: 1, selfApprovalAvoided: true }, { sequence: 2 }],
    });
    expect(JSON.stringify(audit?.metadata)).not.toMatch(/Roberto|Helena|Marcos/u);
  });

  it('[Validação] APPROVER_DUPLICATED e SELF_APPROVAL_FORBIDDEN depois das escritas do encaminhamento desfazem tudo', async () => {
    // Marcelo vira titular da secretaria solicitante: linha 1 (titular) = linha 2 (usuário).
    const duplicated = await createProcess();
    await finalizedDfd(duplicated.id);
    await db.admin('UPDATE departments SET head_user_id = $1 WHERE id = $2', [MARCELO, OBRAS]);
    try {
      const before = await effects(duplicated.id);
      const refused = await forward(
        duplicated,
        await transitionOf(duplicated.id, 'ENVIAR_APROVACAO_DFD'),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(problemDetailsSchema.parse(refused.body).code).toBe('APPROVER_DUPLICATED');
      expect(await effects(duplicated.id)).toEqual(before);
    } finally {
      await db.admin('UPDATE departments SET head_user_id = $1 WHERE id = $2', [MARTA, OBRAS]);
    }

    // Marcelo (linha 2, USER) autor do DFD: sem substituto possível.
    const authored = await createProcess();
    await finalizedDfd(authored.id, MARCELO);
    const before = await effects(authored.id);
    const forbidden = await forward(
      authored,
      await transitionOf(authored.id, 'ENVIAR_APROVACAO_DFD'),
    );
    expect(forbidden.status, JSON.stringify(forbidden.body)).toBe(403);
    expect(problemDetailsSchema.parse(forbidden.body)).toMatchObject({
      code: 'SELF_APPROVAL_FORBIDDEN',
    });
    expect(await effects(authored.id)).toEqual(before);
  });

  it('[Falha de banco] o banco falha ao gravar a 2ª linha: nada do encaminhamento fica (processo, documentos, acessos, outbox)', async () => {
    const process = await createProcess();
    await finalizedDfd(process.id);
    const transitionId = await transitionOf(process.id, 'ENVIAR_APROVACAO_DFD');
    await db.admin(`
      CREATE FUNCTION test_fail_second_line() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.sequence = 2 THEN RAISE EXCEPTION 'falha induzida na 2ª linha'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_second_line BEFORE INSERT ON approval_approvers
        FOR EACH ROW EXECUTE FUNCTION test_fail_second_line();`);
    try {
      const before = await effects(process.id);
      const failed = await forward(process, transitionId);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await effects(process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_second_line ON approval_approvers; DROP FUNCTION test_fail_second_line();',
      );
    }
    const ok = await forward(process, transitionId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('[Concorrência] cinco solicitações simultâneas para a mesma etapa: uma aprovação com as duas linhas, nenhuma linha órfã', async () => {
    const process = await createProcess();
    const client = db.client('cf_app');
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => {
          const approval = approvalOn(process.stageId, process.id);
          return asTenant(A, () =>
            client.$tenantTransaction((tx) =>
              repository.insert(tx, approval, [], [lineOf(approval.id, 1), lineOf(approval.id, 2)]),
            ),
          );
        }),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((item) => item.status === 'rejected')) {
        expect(result.reason).toBeInstanceOf(PendingApprovalExistsError);
      }
      expect((await effects(process.id)).approvals).toHaveLength(1);
      expect((await effects(process.id)).lines).toHaveLength(2);
    } finally {
      await client.$disconnect();
    }
  });

  it('[Validação] índice único parcial por (aprovação, sequence) fora de CANCELED e checks da linha', async () => {
    const process = await createProcess();
    const client = db.client('cf_app');
    const approval = approvalOn(process.stageId, process.id);
    const run = (work: Parameters<typeof client.$tenantTransaction>[0]) =>
      asTenant(A, () => client.$tenantTransaction(work));
    try {
      await run((tx) => repository.insert(tx, approval, [], [lineOf(approval.id, 1)]));
      const insertLine = (line: ApprovalApprover) =>
        run((tx) =>
          tx.approvalApprover.create({
            data: {
              id: line.id,
              tenantId: A,
              approvalId: line.approvalId,
              sequence: line.sequence,
              approverType: line.approverType,
              approverUserId: line.approverUserId,
              allowDeputy: line.allowDeputy,
              status: line.status,
              activatedAt: line.activatedAt,
              skippedReason: line.skippedReason,
              decision: line.decision,
              decidedAt: line.decidedAt,
              decisionComment: line.decisionComment,
            },
          }),
        );
      // Duas linhas vivas na mesma posição: recusado.
      await expect(insertLine(lineOf(approval.id, 1))).rejects.toThrow();
      // Cancelada (redirecionamento — US-135) libera a posição.
      await db.admin(
        "UPDATE approval_approvers SET status = 'CANCELED', skipped_reason = 'REASSIGNED' WHERE approval_id = $1",
        [approval.id],
      );
      await expect(insertLine(lineOf(approval.id, 1))).resolves.toBeDefined();
      // WAITING ativada, PENDING sem ativação, decidida sem decisão, RETURN sem motivo, sequence 21.
      for (const invalid of [
        lineOf(approval.id, 2, { status: 'WAITING', activatedAt: NOW }),
        lineOf(approval.id, 2, { status: 'PENDING', activatedAt: null }),
        lineOf(approval.id, 2, { status: 'APPROVED', decision: null, decidedAt: null }),
        lineOf(approval.id, 2, {
          status: 'RETURNED',
          decision: 'RETURN',
          decidedAt: NOW,
          decisionComment: null,
        }),
        lineOf(approval.id, 21),
        lineOf(approval.id, 2, { approverUserId: null }),
        lineOf(approval.id, 2, { status: 'SKIPPED', skippedReason: 'OUTRO' as never }),
      ]) {
        await expect(insertLine(invalid)).rejects.toThrow();
      }
    } finally {
      await client.$disconnect();
    }
  });

  it('[Sucesso] backfill M2-03: 2.350 aprovações do MVP 1 ganham a linha 1 no estado equivalente; rodar duas vezes não duplica; divergência aborta', async () => {
    const process = await createProcess();
    const pendingProcess = await createProcess();
    // 2.349 encerradas na passagem de abertura (APPROVED, RETURNED, REJECTED, CANCELED) + 1 PENDING.
    await db.admin(`
      INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
        requested_by_id, requested_at, approver_type, approver_user_id, approver_department_id,
        allow_deputy, status, decision, decided_by_id, decided_at, decision_comment,
        decided_as_deputy, canceled_at, cancellation_reason)
      SELECT gen_random_uuid(), '${A}', '${process.id}', 'PROCESS_STAGE', '${process.stageId}',
             'Aprovação do MVP 1', '${ANA}', '2026-10-01T12:00:00Z', 'DEPARTMENT_HEAD', '${MARTA}',
             '${OBRAS}', true,
             (ARRAY['APPROVED','RETURNED','REJECTED','CANCELED'])[1 + n % 4]::approval_status,
             (ARRAY['APPROVE','RETURN','REJECT',NULL])[1 + n % 4]::approval_decision,
             CASE WHEN n % 4 < 3 THEN '${DAVI}'::uuid END,
             CASE WHEN n % 4 < 3 THEN '2026-10-02T12:00:00Z'::timestamptz END,
             CASE WHEN n % 4 IN (1, 2) THEN 'Motivo registrado no MVP 1.' END,
             n % 4 < 3,
             CASE WHEN n % 4 = 3 THEN '2026-10-02T12:00:00Z'::timestamptz END,
             CASE WHEN n % 4 = 3 THEN 'WITHDRAWN' END
        FROM generate_series(1, 2349) AS n;
      INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
        requested_by_id, requested_at, approver_type, approver_user_id, allow_deputy)
      VALUES (gen_random_uuid(), '${A}', '${pendingProcess.id}', 'PROCESS_STAGE',
              '${pendingProcess.stageId}', 'Aprovação pendente do MVP 1', '${ANA}',
              '2026-10-01T12:00:00Z', 'USER', '${MARCELO}', false);`);
    const byStatus = (rows: { status: string; total: string }[]) =>
      Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
    const statusOfApprovals = async () =>
      byStatus(
        await db.admin<{ status: string; total: string }>(
          `SELECT status::text AS status, count(*)::text AS total FROM approvals
            WHERE process_id IN ($1, $2) GROUP BY 1`,
          [process.id, pendingProcess.id],
        ),
      );
    const statusOfLines = async () =>
      byStatus(
        await db.admin<{ status: string; total: string }>(
          `SELECT l.status::text AS status, count(*)::text AS total FROM approval_approvers l
             JOIN approvals a ON a.tenant_id = l.tenant_id AND a.id = l.approval_id
            WHERE a.process_id IN ($1, $2) AND l.sequence = 1 AND l.created_by_id IS NULL
            GROUP BY 1`,
          [process.id, pendingProcess.id],
        ),
      );
    const before = await statusOfApprovals();
    expect(before).toEqual({
      PENDING: 1,
      APPROVED: 587,
      RETURNED: 588,
      REJECTED: 587,
      CANCELED: 587,
    });

    await db.admin(BACKFILL_SQL);
    const first = await statusOfLines();
    await db.admin(BACKFILL_SQL);

    // Reconciliação: as contagens por status batem e a 2ª execução não criou nada.
    expect(first).toEqual(before);
    expect(await statusOfLines()).toEqual(before);
    expect(
      await db.admin(
        `SELECT a.id FROM approvals a
          WHERE a.process_id IN ($1, $2)
            AND (SELECT count(*) FROM approval_approvers l WHERE l.approval_id = a.id) <> 1`,
        [process.id, pendingProcess.id],
      ),
    ).toEqual([]);
    expect(
      await db.admin(
        `SELECT l.decision::text, l.decided_by_id, l.decision_comment, l.decided_as_deputy,
                l.skipped_reason, l.activated_at IS NOT NULL AS activated, a.decision_policy::text
           FROM approval_approvers l JOIN approvals a ON a.id = l.approval_id
          WHERE a.process_id = $1 AND l.status = 'CANCELED'
          LIMIT 1`,
        [process.id],
      ),
    ).toEqual([
      {
        decision: null,
        decided_by_id: null,
        decision_comment: null,
        decided_as_deputy: false,
        skipped_reason: 'WITHDRAWN',
        activated: true,
        decision_policy: 'ANY',
      },
    ]);
    // A pendente continua para o mesmo aprovador (linha PENDING de Marcelo).
    expect(
      await db.admin(
        `SELECT l.status::text, l.approver_user_id FROM approval_approvers l
           JOIN approvals a ON a.id = l.approval_id WHERE a.process_id = $1`,
        [pendingProcess.id],
      ),
    ).toEqual([{ status: 'PENDING', approver_user_id: MARCELO }]);

    // Divergência (linha do backfill em estado diferente da aprovação) aborta a migração.
    await db.admin(
      `UPDATE approval_approvers SET status = 'WAITING', activated_at = NULL
        WHERE approval_id = (SELECT id FROM approvals WHERE process_id = $1)`,
      [pendingProcess.id],
    );
    await expect(db.admin(BACKFILL_SQL)).rejects.toThrow(/approval\.backfill_failed/u);
  });
});
