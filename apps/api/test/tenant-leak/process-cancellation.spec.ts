// Cancelar processo e descartar rascunho sobre PostgreSQL real (US-009 · Sucesso, Falha de banco,
// Concorrência, Duplicidade, Permissão, Tenant incorreto, Falha de integração): a API inteira como
// `cf_app` (RLS) com os seeders reais do provisionamento (workflow padrão DEC-015), o processo criado
// pelo PRC-02 e levado à etapa de aprovação com aprovações pendentes e um DFD em análise, o
// cancelamento pelo PRC-25 e o descarte pelo PRC-06. Prova o CHECK de `cancellation_reason`, a
// transação única (falha induzida DEPOIS de cancelar aprovações e devolver o documento: nada
// persiste), o `FOR UPDATE` com cancelamentos simultâneos, a exclusão lógica fora das leituras, os
// eventos `PENDING` e o processo de outro tenant sem revelar nada.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ProcessListItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c009-0000-7000-8000-00000000010a';
const B = '0192c009-0000-7000-8000-00000000010b';
const ORG_A = '0192c009-0000-7000-8000-0000000010a0';
const ORG_B = '0192c009-0000-7000-8000-0000000010b0';
const OBRAS = '0192c009-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c009-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c009-0000-7000-8000-0000000010a3';
const ANA = '0192c009-0000-7000-8000-0000000010c1';
const CARLA = '0192c009-0000-7000-8000-0000000010c2';
const BETO = '0192c009-0000-7000-8000-0000000010c3';
const JULIANA = '0192c009-0000-7000-8000-0000000010c4';
const ANA_M = '0192c009-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c009-0000-7000-8000-0000000010d2';
const JULIANA_M = '0192c009-0000-7000-8000-0000000010d4';
const NOW = new Date('2026-10-06T13:00:00.000Z');
const DUE_09 = '2026-10-10T02:59:59.999Z';
const MFA = ['pwd', 'otp'];
const REASON = 'Demanda já atendida por contrato vigente';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [JULIANA]: ['REQUISITANTE'],
  [CARLA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us009', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us009', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us009', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', 'sub-carla-us009', 'carla@a.test', true, 'Carla Mendes'),
  ('${JULIANA}', 'sub-juliana-us009', 'juliana@a.test', true, 'Juliana Reis'),
  ('${BETO}', 'sub-beto-us009', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('${JULIANA_M}', '${A}', '${JULIANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c009-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c009-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c009-0000-7000-8000-0000000010e4', '${A}', '${JULIANA_M}', '${PLANEJAMENTO}', true);
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

interface Staged {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Cancelar processo ou descartar rascunho sobre PostgreSQL (US-009)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us009' ? B : A);
  const as = (call: request.Test, subject: string) =>
    call
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const cancel = (
    process: Pick<Staged, 'id' | 'version'>,
    options: { subject?: string; reason?: string } = {},
  ) =>
    as(
      request(api.server).post(`/api/v1/processes/${process.id}/cancel`),
      options.subject ?? 'sub-carla-us009',
    )
      .set('If-Match', `"${String(process.version)}"`)
      .send({ cancellationReason: options.reason ?? REASON });
  const discard = (process: Pick<Staged, 'id' | 'version'>, subject = 'sub-carla-us009') =>
    as(request(api.server).delete(`/api/v1/processes/${process.id}`), subject)
      .set('If-Match', `"${String(process.version)}"`)
      .send();
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const stageOf = async (processId: string, key: string) => {
    const [row] = await db.admin<{ id: string }>(
      `SELECT s.id FROM workflow_stages s JOIN processes p ON p.workflow_version_id = s.workflow_version_id
        WHERE p.id = $1 AND s.key = $2`,
      [processId, key],
    );
    if (!row) throw new Error(`workflow_stages/${key} ausente`);
    return row.id;
  };

  /** PRC-02 (Ana): o rascunho na etapa inicial, com a responsabilidade ativa. */
  async function created(): Promise<ProcessDto> {
    const response = await as(request(api.server).post('/api/v1/processes'), 'sub-ana-us009')
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
    return (response.body as { data: ProcessDto }).data;
  }

  /**
   * O processo na etapa APROVACAO_DFD (`AWAITING_APPROVAL`) na Coordenadoria, com Juliana
   * responsável, a aprovação de etapa pendente e uma aprovação avulsa pendente que cobre o DFD
   * `IN_REVIEW`.
   */
  async function awaitingApproval() {
    const process = await created();
    const stageId = randomUUID();
    const workflowStage = await stageOf(process.id, 'APROVACAO_DFD');
    const stageApproval = randomUUID();
    const documentApproval = randomUUID();
    const dfd = randomUUID();
    const [type] = await db.admin<{ id: string }>(
      "SELECT id FROM document_types WHERE tenant_id = $1 AND code = 'DFD'",
      [A],
    );
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${process.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${process.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, due_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${process.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${JULIANA}', '2026-10-01T12:00:00Z', '${DUE_09}', 5, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${process.id}', '${stageId}', '${PLANEJAMENTO}',
                 '${JULIANA}', 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'AWAITING_APPROVAL', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${PLANEJAMENTO}',
              current_responsible_id = '${JULIANA}', current_stage_due_at = '${DUE_09}'
        WHERE id = '${process.id}';
       INSERT INTO documents (id, tenant_id, process_id, document_type_id, title, status,
                              pending_approval_id, created_by_id)
         VALUES ('${dfd}', '${A}', '${process.id}', '${type?.id ?? ''}', 'DFD da demanda',
                 'IN_REVIEW', '${documentApproval}', '${ANA}');
       INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
                              requested_by_id, approver_type, approver_user_id, allow_deputy, due_at)
         VALUES ('${stageApproval}', '${A}', '${process.id}', 'PROCESS_STAGE', '${stageId}',
                 'Aprovação do DFD', '${ANA}', 'USER', '${CARLA}', false, '${DUE_09}');
       INSERT INTO approvals (id, tenant_id, process_id, subject_type, document_id, title,
                              requested_by_id, approver_type, approver_user_id, allow_deputy)
         VALUES ('${documentApproval}', '${A}', '${process.id}', 'DOCUMENT', '${dfd}',
                 'Aprovação avulsa — DFD', '${ANA}', 'USER', '${CARLA}', false);
       COMMIT;`,
    );
    return {
      process: { id: process.id, stageId, version: process.version },
      approvals: [stageApproval, documentApproval],
      dfd,
    };
  }

  /** Rascunho SEM número (numeração em `START`), com a etapa inicial ativa. */
  async function unnumberedDraft(): Promise<Staged> {
    const process = await created();
    await db.admin('UPDATE processes SET number = NULL, code = NULL WHERE id = $1', [process.id]);
    const [stage] = await db.admin<{ id: string }>(
      "SELECT id FROM process_stages WHERE process_id = $1 AND status = 'ACTIVE'",
      [process.id],
    );
    return { id: process.id, stageId: stage?.id ?? '', version: process.version };
  }

  /** Tudo que cancelar/descartar grava (para provar o rollback e a recusa). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, canceled_at, canceled_by_id, cancellation_reason, deleted_at,
                deleted_by_id, version
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0],
    stages: await db.admin<Row>(
      `SELECT id, status::text, exited_at, exited_via_movement_id
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    assignments: await db.admin<Row>(
      'SELECT is_active, ended_at FROM process_assignments WHERE process_id = $1 ORDER BY started_at',
      [id],
    ),
    movements: await db.admin<Row>(
      `SELECT sequence, action::text, comment, status_from::text, status_to::text
         FROM process_movements WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    approvals: await db.admin<Row>(
      `SELECT id, status::text, canceled_at, canceled_by_id, cancellation_reason
         FROM approvals WHERE process_id = $1 ORDER BY id`,
      [id],
    ),
    documents: await db.admin<Row>(
      'SELECT id, status::text, pending_approval_id FROM documents WHERE process_id = $1 ORDER BY id',
      [id],
    ),
    timeline: await db.admin<Row>(
      'SELECT type::text FROM process_timeline_entries WHERE process_id = $1 ORDER BY type',
      [id],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action <> 'process.create' ORDER BY action",
      [id],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND event_type <> 'ProcessCreated' ORDER BY event_type, routing_key`,
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
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'workflow.seedWorkflows',
    ]);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] cancela: CANCELED, aprovações canceladas, DFD de volta a DRAFT, etapa e responsabilidade encerradas, timeline, auditoria e eventos PENDING', async () => {
    const { process, approvals, dfd } = await awaitingApproval();
    const response = await cancel(process);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const after = await effects(process.id);
    expect(after.process).toMatchObject({
      status: 'CANCELED',
      canceled_at: NOW,
      canceled_by_id: CARLA,
      cancellation_reason: REASON,
      deleted_at: null,
      version: process.version + 1,
    });
    const [movement] = after.movements.filter((row) => row.action === 'CANCEL');
    expect(movement).toMatchObject({
      comment: REASON,
      status_from: 'AWAITING_APPROVAL',
      status_to: 'CANCELED',
    });
    expect(after.stages.find((row) => row.id === process.stageId)).toMatchObject({
      status: 'CANCELED',
      exited_at: NOW,
    });
    expect(after.stages.some((row) => row.status === 'ACTIVE')).toBe(false);
    expect(after.assignments.every((row) => row.is_active === false)).toBe(true);
    expect(after.approvals).toEqual(
      [...approvals].sort().map((id) => ({
        id,
        status: 'CANCELED',
        canceled_at: NOW,
        canceled_by_id: CARLA,
        cancellation_reason: 'PROCESS_CANCELED',
      })),
    );
    expect(after.documents).toEqual([{ id: dfd, status: 'DRAFT', pending_approval_id: null }]);
    expect(after.timeline.map((row) => row.type)).toEqual(
      expect.arrayContaining(['PROCESS_CANCELED', 'APPROVAL_CANCELED', 'DOCUMENT_WITHDRAWN']),
    );
    expect(after.audit.map((row) => row.action)).toEqual([
      'approval.cancel',
      'approval.cancel',
      'document.withdraw',
      'process.cancel',
    ]);
    // [Falha de integração] relay fora: os eventos ficam PENDING no outbox.
    expect(after.events).toEqual([
      { event_type: 'ApprovalCanceled', routing_key: 'approval.canceled', status: 'PENDING' },
      { event_type: 'ApprovalCanceled', routing_key: 'approval.canceled', status: 'PENDING' },
      {
        event_type: 'DocumentWithdrawn',
        routing_key: 'document.withdrawn.dfd',
        status: 'PENDING',
      },
      {
        event_type: 'ProcessStatusChanged',
        routing_key: 'process.status_changed.canceled',
        status: 'PENDING',
      },
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de cancelar aprovações e devolver o documento desfaz tudo', async () => {
    const { process } = await awaitingApproval();
    await db.admin(`
      CREATE FUNCTION test_fail_cancel_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_CANCELED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_cancel_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_cancel_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await cancel(process);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
      expect(before.process).toMatchObject({ status: 'AWAITING_APPROVAL' });
      expect(before.approvals.every((row) => row.status === 'PENDING')).toBe(true);
      expect(before.documents.every((row) => row.status === 'IN_REVIEW')).toBe(true);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_cancel_timeline ON process_timeline_entries; DROP FUNCTION test_fail_cancel_timeline();',
      );
    }
  });

  it('[Validação] o CHECK barra processo CANCELED sem justificativa', async () => {
    const process = await created();
    await expect(
      db.admin("UPDATE processes SET status = 'CANCELED' WHERE id = $1", [process.id]),
    ).rejects.toThrow(/cancellation_reason|check/i);
  });

  it('[Concorrência] 5 cancelamentos simultâneos com o mesmo If-Match: um 200; os demais 409/412; uma tramitação CANCEL', async () => {
    const { process } = await awaitingApproval();
    const responses = await Promise.all(Array.from({ length: 5 }, () => cancel(process)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      expect(['INVALID_PROCESS_STATUS', 'VERSION_CONFLICT']).toContain(
        problemDetailsSchema.parse(response.body).code,
      );
    }
    const after = await effects(process.id);
    expect(after.movements.filter((row) => row.action === 'CANCEL')).toHaveLength(1);
    expect(after.audit.filter((row) => row.action === 'process.cancel')).toHaveLength(1);
  });

  it('[Duplicidade] reenvio após o sucesso: 409 INVALID_PROCESS_STATUS e nada novo', async () => {
    const { process } = await awaitingApproval();
    expect((await cancel(process)).status).toBe(200);
    const after = await effects(process.id);
    const again = await cancel(process);
    expect(again.status).toBe(409);
    expect(problemDetailsSchema.parse(again.body).code).toBe('INVALID_PROCESS_STATUS');
    expect(await effects(process.id)).toEqual(after);
  });

  it('[Sucesso] descarta o rascunho sem número: exclusão lógica, fora da lista e do detalhe, etapa encerrada, evento PENDING e sem timeline', async () => {
    const draft = await unnumberedDraft();
    const before = await effects(draft.id);
    const response = await discard(draft);
    expect(response.status, JSON.stringify(response.body)).toBe(204);

    const after = await effects(draft.id);
    expect(after.process).toMatchObject({
      status: 'DRAFT',
      deleted_at: NOW,
      deleted_by_id: CARLA,
      version: draft.version + 1,
    });
    expect(after.stages.find((row) => row.id === draft.stageId)).toMatchObject({
      status: 'CANCELED',
      exited_at: NOW,
      exited_via_movement_id: null,
    });
    expect(after.assignments.every((row) => row.is_active === false)).toBe(true);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.audit).toEqual([{ action: 'process.discard_draft' }]);
    expect(after.events).toEqual([
      {
        event_type: 'ProcessDraftDiscarded',
        routing_key: 'process.draft_discarded',
        status: 'PENDING',
      },
    ]);

    const detail = await as(
      request(api.server).get(`/api/v1/processes/${draft.id}`),
      'sub-carla-us009',
    );
    expect(detail.status).toBe(404);
    const list = await as(
      request(api.server).get('/api/v1/processes?pageSize=100'),
      'sub-carla-us009',
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((list.body as { data: ProcessListItemDto[] }).data.map((row) => row.id)).not.toContain(
      draft.id,
    );
    // Um segundo descarte não encontra o processo excluído.
    expect((await discard({ ...draft, version: draft.version + 1 })).status).toBe(404);
  });

  it('[Validação] descartar rascunho numerado = 409 CANNOT_DISCARD_NUMBERED_PROCESS sem alterar nada', async () => {
    const process = await created();
    await db.admin(
      "UPDATE processes SET number = COALESCE(number, 913), code = COALESCE(code, '0913/2026') WHERE id = $1",
      [process.id],
    );
    const before = await effects(process.id);
    const response = await discard(process);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(problemDetailsSchema.parse(response.body).code).toBe('CANNOT_DISCARD_NUMBERED_PROCESS');
    expect(await effects(process.id)).toEqual(before);
  });

  it('[Permissão] REQUISITANTE sem PROCESS_CANCEL = 403 PERMISSION_DENIED com access.denied e nada alterado', async () => {
    const { process } = await awaitingApproval();
    const before = await effects(process.id);
    const response = await cancel(process, { subject: 'sub-juliana-us009' });
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    const after = await effects(process.id);
    expect({ ...after, audit: before.audit }).toEqual(before);
    const [denied] = await db.admin<Row>(
      "SELECT reason_code FROM audit_logs WHERE action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(denied).toMatchObject({ reason_code: 'PROCESS_CANCEL' });
  });

  it('[Tenant incorreto] processo de A pelo tenant B = 404 PROCESS_NOT_FOUND, sem revelar nem alterar nada', async () => {
    const { process } = await awaitingApproval();
    const draft = await unnumberedDraft();
    const before = [await effects(process.id), await effects(draft.id)];
    const foreign = await cancel(process, { subject: 'sub-beto-us009' });
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
    const foreignDiscard = await discard(draft, 'sub-beto-us009');
    expect(foreignDiscard.status).toBe(404);
    expect([await effects(process.id), await effects(draft.id)]).toEqual(before);
  });
});
