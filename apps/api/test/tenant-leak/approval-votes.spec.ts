// Decisão por linha da aprovação múltipla sobre PostgreSQL real (US-134 · Sucesso, Tenant
// incorreto, Concorrência, Falha de banco e Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais do provisionamento e a etapa APROVACAO_DFD do workflow padrão configurada com
// a política `ALL` (1. titular da secretaria solicitante — Carla, substituto Diego; 2. o usuário
// Marcelo). Prova que o voto que não encerra grava só a linha e a aprovação (documento, etapa e
// status intactos) com `ApprovalVoteRecorded` `PENDING` no outbox; que o voto final aplica os efeitos
// da US-052 uma vez, com `votes[]`; que uma falha induzida no encerramento desfaz o voto inteiro;
// que votos simultâneos em linhas diferentes resultam num único encerramento e na mesma linha numa
// só decisão (`FOR UPDATE`); que o gatilho de imutabilidade recusa alterar a linha decidida; e que
// as linhas de A não existem para B. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DecideApprovalMeta, ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
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

const A = '0192c134-0000-7000-8000-00000000010a';
const B = '0192c134-0000-7000-8000-00000000010b';
const ORG_A = '0192c134-0000-7000-8000-0000000010a0';
const ORG_B = '0192c134-0000-7000-8000-0000000010b0';
const OBRAS = '0192c134-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c134-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c134-0000-7000-8000-0000000010b1';
const ANA = '0192c134-0000-7000-8000-0000000010c1';
const CARLA = '0192c134-0000-7000-8000-0000000010c2';
const DIEGO = '0192c134-0000-7000-8000-0000000010c3';
const MARCELO = '0192c134-0000-7000-8000-0000000010c4';
const BETO = '0192c134-0000-7000-8000-0000000010c6';
const ANA_M = '0192c134-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-11-12T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['AUTORIDADE_COMPETENTE'],
  [DIEGO]: ['AUTORIDADE_COMPETENTE'],
  [MARCELO]: ['AUTORIDADE_COMPETENTE'],
  [BETO]: ['AUTORIDADE_COMPETENTE'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us134', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us134', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us134', 'ana@a.test', true, 'Ana Requisitante'),
  ('${CARLA}', 'sub-carla-us134', 'carla@a.test', true, 'Carla Titular'),
  ('${DIEGO}', 'sub-diego-us134', 'diego@a.test', true, 'Diego Substituto'),
  ('${MARCELO}', 'sub-marcelo-us134', 'marcelo@a.test', true, 'Marcelo Procurador'),
  ('${BETO}', 'sub-beto-us134', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${CARLA}', '${DIEGO}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, '${BETO}', NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c134-0000-7000-8000-0000000010d2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c134-0000-7000-8000-0000000010d3', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('0192c134-0000-7000-8000-0000000010d4', '${A}', '${MARCELO}', 'INTERNAL', 'ACTIVE'),
  ('0192c134-0000-7000-8000-0000000010d6', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c134-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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
  readonly versionId: string;
}

describe('Feature: Decidir aprovação múltipla sobre PostgreSQL (US-134)', () => {
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
    options: { subject: string; tenant?: string; ifMatch?: string; key?: string },
  ) =>
    request(api.server)
      .post(`/api/v1/approvals/${approvalId}/decide`)
      .set('Authorization', api.bearer(options.subject, { amr: MFA }))
      .set('X-Tenant-Id', options.tenant ?? A)
      .set('If-Match', options.ifMatch ?? '"1"')
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const outcomeOf = (response: request.Response) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { meta: DecideApprovalMeta }).meta.outcome;
  };
  const linesOf = (approvalId: string) =>
    db.admin<Row & { id: string }>(
      `SELECT id, sequence, status::text, decision::text, decided_by_id, decided_as_deputy,
              skipped_reason, version
         FROM approval_approvers WHERE approval_id = $1 ORDER BY sequence`,
      [approvalId],
    );

  /** Processo na ABERTURA com o DFD finalizado (v1), encaminhado à APROVACAO_DFD (`ALL`). */
  async function pendingDfdApproval(): Promise<Pending> {
    const created = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us134', { amr: MFA }))
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
      .set('Authorization', api.bearer('sub-ana-us134', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.currentStage?.id, transitionId });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    const approval = (forwarded.body as { data: ForwardedProcessDto }).data.approval;
    expect(approval).toMatchObject({ decisionPolicy: 'ALL' });
    return { processId: process.id, approvalId: approval?.id ?? '', documentId, versionId };
  }

  /** Tudo que o voto grava — para provar o rollback. */
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
      `SELECT id, status::text, decision::text, decided_by_id, approver_user_id, version
         FROM approvals WHERE process_id = $1 ORDER BY created_at`,
      [processId],
    ),
    lines: await db.admin<Row>(
      `SELECT l.sequence, l.status::text, l.decision::text, l.decided_by_id, l.version
         FROM approval_approvers l JOIN approvals a ON a.id = l.approval_id
        WHERE a.process_id = $1 ORDER BY l.sequence`,
      [processId],
    ),
    documents: await db.admin<Row>(
      `SELECT id, status::text, pending_approval_id, approved_version_id FROM documents
        WHERE process_id = $1 ORDER BY id`,
      [processId],
    ),
    renditions: await db.admin<Row>(
      `SELECT kind::text, status::text, approval_id FROM document_renditions
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

  it('[Sucesso]/[Falha de banco]/[Falha de integração] voto que não encerra, falha induzida no encerramento desfaz tudo e o voto final aplica os efeitos uma vez', async () => {
    const pending = await pendingDfdApproval();
    const opened = await effects(pending.processId);

    // Carla (titular) vota: só a linha 1 e a aprovação mudam.
    expect(
      outcomeOf(
        await decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us134' }),
      ),
    ).toBe('VOTE_RECORDED');
    const voted = await effects(pending.processId);
    expect(voted.process).toEqual(opened.process);
    expect(voted.stages).toEqual(opened.stages);
    expect(voted.movements).toEqual(opened.movements);
    expect(voted.documents).toEqual(opened.documents);
    expect(voted.renditions).toEqual([]);
    expect(voted.approvals).toEqual([
      expect.objectContaining({ status: 'PENDING', decision: null, version: 2 }),
    ]);
    expect(voted.lines).toEqual([
      { sequence: 1, status: 'APPROVED', decision: 'APPROVE', decided_by_id: CARLA, version: 2 },
      { sequence: 2, status: 'PENDING', decision: null, decided_by_id: null, version: 1 },
    ]);
    expect(voted.audit.map((row) => row.action)).toContain('approval.vote');
    expect(voted.timeline.map((row) => row.type)).toContain('APPROVAL_VOTE_RECORDED');
    expect(voted.events).toEqual(
      expect.arrayContaining([
        {
          event_type: 'ApprovalVoteRecorded',
          routing_key: 'approval.vote_recorded',
          status: 'PENDING',
        },
      ]),
    );

    // [Falha de banco] O selo falha DEPOIS da aprovação, das linhas, do documento e da etapa.
    await db.admin(`
      CREATE FUNCTION test_fail_document_renditions() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'falha induzida no teste'; END $fn$;
      CREATE TRIGGER test_fail_document_renditions BEFORE INSERT ON document_renditions
        FOR EACH ROW EXECUTE FUNCTION test_fail_document_renditions();`);
    try {
      const failed = await decide(
        pending.approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-marcelo-us134' },
      );
      expect(failed.status).toBe(500);
      expect(await effects(pending.processId)).toEqual(voted);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_document_renditions ON document_renditions; DROP FUNCTION test_fail_document_renditions();',
      );
    }

    // Marcelo encerra: efeitos da US-052 uma vez, linhas e votos completos.
    const closing = await decide(
      pending.approvalId,
      { decision: 'APPROVE' },
      { subject: 'sub-marcelo-us134' },
    );
    expect(outcomeOf(closing)).toBe('APPROVED');
    const closed = await effects(pending.processId);
    expect(closed.approvals).toEqual([
      {
        id: pending.approvalId,
        status: 'APPROVED',
        decision: 'APPROVE',
        decided_by_id: MARCELO,
        approver_user_id: MARCELO,
        version: 3,
      },
    ]);
    expect(closed.lines.map((line) => line.status)).toEqual(['APPROVED', 'APPROVED']);
    expect(closed.documents).toEqual([
      {
        id: pending.documentId,
        status: 'APPROVED',
        pending_approval_id: null,
        approved_version_id: pending.versionId,
      },
    ]);
    expect(closed.renditions).toEqual([
      { kind: 'APPROVAL_STAMPED', status: 'PENDING', approval_id: pending.approvalId },
    ]);
    expect(closed.process[0]).toMatchObject({ status: 'IN_PROGRESS' });
    expect(closed.audit.filter((row) => row.action === 'approval.decide')).toHaveLength(1);
    const [completed] = await db.admin<{ status: string; payload: Row }>(
      `SELECT status::text, payload FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'ApprovalCompleted'`,
      [pending.approvalId],
    );
    // O relay não roda no teste: o evento fica PENDING até ele voltar.
    expect(completed?.status).toBe('PENDING');
    expect(completed?.payload).toMatchObject({
      decisionPolicy: 'ALL',
      votes: [
        { sequence: 1, decision: 'APPROVE', decidedById: CARLA },
        { sequence: 2, decision: 'APPROVE', decidedById: MARCELO },
      ],
    });

    // RN-APV-42: a linha decidida é imutável no banco (gatilho), mesmo para o dono.
    await expect(
      db.admin(
        `UPDATE approval_approvers SET decision = 'REJECT', status = 'REJECTED',
                decision_comment = 'Troca de voto indevida' WHERE approval_id = $1 AND sequence = 1`,
        [pending.approvalId],
      ),
    ).rejects.toThrow(/imutável/);
    expect((await linesOf(pending.approvalId))[0]).toMatchObject({ decision: 'APPROVE' });
  });

  it('[Concorrência] votos simultâneos em linhas diferentes: aplicados em série e um único encerramento', async () => {
    const pending = await pendingDfdApproval();

    const responses = await Promise.all([
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us134' }),
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-marcelo-us134' }),
    ]);

    expect(responses.map(outcomeOf).sort()).toEqual(['APPROVED', 'VOTE_RECORDED']);
    const after = await effects(pending.processId);
    expect(after.approvals).toEqual([expect.objectContaining({ status: 'APPROVED', version: 3 })]);
    expect(after.lines.map((line) => line.status)).toEqual(['APPROVED', 'APPROVED']);
    expect(after.events.filter((row) => row.event_type === 'ApprovalCompleted')).toHaveLength(1);
    expect(after.renditions).toHaveLength(1);
  });

  it('[Concorrência] titular e substituto na mesma linha: só uma decisão; a outra 409 APPROVAL_LINE_NOT_PENDING', async () => {
    const pending = await pendingDfdApproval();

    const responses = await Promise.all([
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us134' }),
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-diego-us134' }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(problemDetailsSchema.parse(loser?.body).code).toBe('APPROVAL_LINE_NOT_PENDING');
    const lines = await linesOf(pending.approvalId);
    expect(lines.map((line) => line.status)).toEqual(['APPROVED', 'PENDING']);
    expect(
      (await effects(pending.processId)).audit.filter((row) => row.action === 'approval.vote'),
    ).toHaveLength(1);
  });

  it('[Concorrência] a mesma Idempotency-Key em paralelo grava um único voto', async () => {
    const pending = await pendingDfdApproval();
    const key = randomUUID();

    const responses = await Promise.all([
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us134', key }),
      decide(pending.approvalId, { decision: 'APPROVE' }, { subject: 'sub-carla-us134', key }),
    ]);

    expect(responses.some((response) => response.status === 200)).toBe(true);
    for (const response of responses) expect([200, 409]).toContain(response.status);
    const after = await effects(pending.processId);
    expect(after.audit.filter((row) => row.action === 'approval.vote')).toHaveLength(1);
    expect(after.events.filter((row) => row.event_type === 'ApprovalVoteRecorded')).toHaveLength(1);
  });

  it('[Tenant incorreto] as linhas de A não existem para B: 404 na decisão e a RLS as esconde', async () => {
    const pending = await pendingDfdApproval();

    const response = await decide(
      pending.approvalId,
      { decision: 'APPROVE' },
      { subject: 'sub-beto-us134', tenant: B },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('APPROVAL_NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('Carla');
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
      // Nem por SQL direto o tenant B altera a linha de A (RLS: zero linhas afetadas).
      const touched = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE approval_approvers SET status = 'APPROVED', decision = 'APPROVE',
                  decided_at = now(), decided_by_id = ${BETO}::uuid
                WHERE approval_id = ${pending.approvalId}::uuid`,
        ),
      );
      expect(touched).toBe(0);
    } finally {
      await client.$disconnect();
    }
    expect((await linesOf(pending.approvalId)).map((line) => line.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
  });
});
