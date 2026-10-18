// Encaminhamento do processo sobre PostgreSQL real (US-047 · Sucesso, Falha de banco, Concorrência,
// Tenant incorreto, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento (workflow padrão DEC-015, feriados nacionais), o processo criado pelo PRC-02 e
// levado à etapa ESTUDOS_PRELIMINARES, e o encaminhamento pelo PRC-19. Prova a transação única
// (falha induzida DEPOIS de gravar a nova etapa: nada persiste — processo, passagens,
// responsabilidades, tramitação, número, aprovação, acessos, timeline, auditoria e outbox), a
// autuação no 1º encaminhamento, a concessão CURRENT → HISTORICAL, o `FOR UPDATE` com 20
// encaminhamentos simultâneos (um 200, os demais 409 `STAGE_CHANGED`), os eventos `PENDING` e a RLS.
// O ETP/mapa de riscos ainda não têm módulo dono que contribua ao `RuleContext` (US-019/US-035): um
// contribuidor de teste entrega os fatos. `pnpm --filter @contrataflow/api test:tenant-leak`.
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
import { registerTestDocumentFacts } from '../support/process-forward-fixtures.js';
import type { TestDocumentFacts } from '../support/process-forward-fixtures.js';

const A = '0192c047-0000-7000-8000-00000000010a';
const B = '0192c047-0000-7000-8000-00000000010b';
const ORG_A = '0192c047-0000-7000-8000-0000000010a0';
const ORG_B = '0192c047-0000-7000-8000-0000000010b0';
const OBRAS = '0192c047-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c047-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c047-0000-7000-8000-0000000010a3';
const COMPRAS = '0192c047-0000-7000-8000-0000000010a4';
const OBRAS_B = '0192c047-0000-7000-8000-0000000010b1';
const ANA = '0192c047-0000-7000-8000-0000000010c1';
const MARTA = '0192c047-0000-7000-8000-0000000010c2';
const BETO = '0192c047-0000-7000-8000-0000000010c3';
const ANA_M = '0192c047-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
/** 20/10/2026 23:59:59 em São Paulo: 10 dias úteis sem fins de semana e o feriado de 12/10. */
const DUE_20_10 = '2026-10-21T02:59:59.999Z';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [MARTA]: ['ADMIN_ORGAO'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us047', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us047', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us047', 'ana@a.test', true, 'Ana Souza'),
  ('${MARTA}', 'sub-marta-us047', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${BETO}', 'sub-beto-us047', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, '${MARTA}'),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL),
  ('${COMPRAS}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Departamento de Compras', '${path(COMPRAS)}', 0, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c047-0000-7000-8000-0000000010d2', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c047-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c047-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c047-0000-7000-8000-0000000010e2', '${A}', '${ANA_M}', '${PLANEJAMENTO}', false);
INSERT INTO tenant_settings (id, tenant_id, key, value) VALUES
  ('0192c047-0000-7000-8000-0000000010f1', '${A}', 'numbering.process.assignOn', '"START"');
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

interface Studies {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Encaminhar processo sobre PostgreSQL (US-047)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let facts: TestDocumentFacts;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us047' ? B : A);
  const forward = (process: Studies, body: Record<string, unknown>, subject = 'sub-ana-us047') =>
    request(api.server)
      .post(`/api/v1/processes/${process.id}/forward`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStageId: process.stageId, ...body });
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const workflowRef = async (processId: string, table: string, key: string) => {
    const [row] = await db.admin<{ id: string }>(
      `SELECT t.id FROM ${table} t JOIN processes p ON p.workflow_version_id = t.workflow_version_id
        WHERE p.id = $1 AND t.key = $2`,
      [processId, key],
    );
    if (!row) throw new Error(`${table}/${key} ausente`);
    return row.id;
  };

  /** PRC-02 (Ana, ABERTURA) e a passagem ESTUDOS_PRELIMINARES ativa na Coordenadoria (versão 1). */
  async function processAtStudies(): Promise<Studies> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us047', { amr: MFA }))
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
    const stageId = randomUUID();
    const studies = await workflowRef(created.id, 'workflow_stages', 'ESTUDOS_PRELIMINARES');
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = now() WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = now() WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${studies}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${ANA}', '2026-10-01T12:00:00Z', 15, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${PLANEJAMENTO}', '${ANA}',
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${studies}', current_department_id = '${PLANEJAMENTO}'
        WHERE id = '${created.id}';
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${PLANEJAMENTO}', 'CURRENT');
       COMMIT;`,
    );
    facts.set(created.id, [
      {
        documentTypeCode: 'ETP',
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 2,
        approvedAt: null,
      },
      {
        documentTypeCode: 'RISK_MAP',
        status: 'DRAFT',
        isComplete: false,
        versionNumber: null,
        approvedAt: null,
      },
    ]);
    return { id: created.id, stageId, version: created.version };
  }

  const sequenceValue = async () =>
    (
      await db.admin<{ last_value: number }>(
        "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key LIKE 'PROCESS:%'",
        [A],
      )
    )[0]?.last_value ?? 0;

  /** Tudo que o encaminhamento grava (para provar o rollback). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, number, code, opened_at, version, current_stage_id,
                current_department_id, current_responsible_id, current_stage_due_at
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0],
    stages: await db.admin<Row>(
      `SELECT id, sequence, status::text, department_id, due_at, exited_via_movement_id
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    assignments: await db.admin<Row>(
      `SELECT process_stage_id, assignee_id, is_active FROM process_assignments
        WHERE process_id = $1 ORDER BY started_at, id`,
      [id],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence, action::text FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    access: await db.admin<Row>(
      `SELECT reason::text, department_id, user_id, revoked_at IS NOT NULL AS revoked
         FROM process_access WHERE process_id = $1 ORDER BY reason, department_id, user_id`,
      [id],
    ),
    approvals: await db.admin<Row>(
      'SELECT status::text, approver_user_id FROM approvals WHERE process_id = $1',
      [id],
    ),
    timeline: await db.admin<Row>(
      'SELECT type::text FROM process_timeline_entries WHERE process_id = $1 ORDER BY occurred_at, type',
      [id],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action <> 'process.create' ORDER BY action",
      [id],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND event_type <> 'ProcessCreated' ORDER BY event_type`,
      [id],
    ),
    sequence: await sequenceValue(),
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
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B);
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

  it('[Sucesso] ESTUDOS → PESQUISA (unidade escolhida): passagens, responsabilidades, tramitação, autuação, HISTORICAL/CURRENT, timeline, auditoria e eventos PENDING no mesmo commit', async () => {
    const process = await processAtStudies();
    const before = await sequenceValue();
    const response = await forward(process, {
      transitionId: await workflowRef(process.id, 'workflow_transitions', 'ENVIAR_PESQUISA'),
      toDepartmentId: COMPRAS,
      comment: 'ETP concluído; seguem ETP e mapa de riscos',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const dto = (response.body as { data: ForwardedProcessDto }).data;
    expect(response.headers.etag).toBe(`"${String(process.version + 1)}"`);
    expect(dto).toMatchObject({ numberAssigned: true, currentStage: { dueAt: DUE_20_10 } });

    const after = await effects(process.id);
    expect(after.sequence).toBe(before + 1);
    expect(after.process).toMatchObject({
      status: 'IN_PROGRESS',
      code: dto.code,
      version: process.version + 1,
      current_department_id: COMPRAS,
      current_responsible_id: null,
    });
    expect(after.process?.opened_at).not.toBeNull();
    expect(new Date(String(after.process?.current_stage_due_at)).toISOString()).toBe(DUE_20_10);
    const [opening, studies, pesquisa, ...more] = after.stages;
    expect(more).toEqual([]);
    expect(opening).toMatchObject({ status: 'COMPLETED' });
    expect(studies).toMatchObject({
      id: process.stageId,
      status: 'COMPLETED',
      exited_via_movement_id: dto.movement.id,
    });
    expect(pesquisa).toMatchObject({ sequence: 3, status: 'ACTIVE', department_id: COMPRAS });
    expect(after.assignments.filter((row) => row.is_active === true)).toEqual([
      { process_stage_id: pesquisa?.id, assignee_id: null, is_active: true },
    ]);
    expect(after.movements).toEqual([
      { sequence: 1, action: 'CREATE' },
      { sequence: 2, action: 'FORWARD' },
    ]);
    const [movement] = await db.admin<Row>(
      `SELECT from_department_id, to_department_id, actor_id, actor_department_id, comment, ip,
              user_agent, correlation_id, metadata, documents
         FROM process_movements WHERE id = $1`,
      [dto.movement.id],
    );
    expect(movement).toMatchObject({
      from_department_id: PLANEJAMENTO,
      to_department_id: COMPRAS,
      actor_id: ANA,
      actor_department_id: PLANEJAMENTO,
      comment: 'ETP concluído; seguem ETP e mapa de riscos',
      metadata: expect.objectContaining({
        v: 1,
        computedDueAt: DUE_20_10,
        dueDateOverridden: false,
        labels: expect.objectContaining({
          fromDepartment: 'Coordenadoria de Planejamento',
          toDepartment: 'Departamento de Compras',
        }) as unknown,
      }) as unknown,
      documents: [],
    });
    expect(movement?.correlation_id).toEqual(expect.any(String));
    expect(after.access).toEqual(
      expect.arrayContaining([
        { reason: 'CURRENT', department_id: PLANEJAMENTO, user_id: null, revoked: true },
        { reason: 'HISTORICAL', department_id: PLANEJAMENTO, user_id: null, revoked: false },
        { reason: 'CURRENT', department_id: COMPRAS, user_id: null, revoked: false },
      ]),
    );
    expect(after.timeline.map((row) => row.type)).toEqual(
      expect.arrayContaining(['PROCESS_FORWARDED', 'PROCESS_NUMBER_ASSIGNED']),
    );
    expect(after.audit.map((row) => row.action)).toEqual([
      'process.forward',
      'process.number_assign',
    ]);
    // [Falha de integração] relay fora: os eventos ficam PENDING no outbox.
    expect(after.events).toEqual([
      {
        event_type: 'ProcessNumberAssigned',
        routing_key: 'process.number_assigned',
        status: 'PENDING',
      },
      {
        event_type: 'ProcessStageChanged',
        routing_key: 'process.stage_changed.forward',
        status: 'PENDING',
      },
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar a nova etapa desfaz passagens, tramitação, número, acessos, timeline, auditoria e eventos', async () => {
    const process = await processAtStudies();
    await db.admin(`
      CREATE FUNCTION test_fail_forward_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_FORWARDED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_forward_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_forward_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await forward(process, {
        transitionId: await workflowRef(process.id, 'workflow_transitions', 'ENVIAR_PESQUISA'),
        toDepartmentId: COMPRAS,
      });
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_forward_timeline ON process_timeline_entries; DROP FUNCTION test_fail_forward_timeline();',
      );
    }
  });

  it('[Falha de banco] destino APPROVAL: falha induzida na aprovação desfaz a aprovação e todo o encaminhamento', async () => {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us047', { amr: MFA }))
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
    // DFD "completo" pelo contribuidor de teste e sem documento de DFD: aprovação sem cobertura.
    facts.set(created.id, [
      {
        documentTypeCode: 'DFD',
        status: 'DRAFT',
        isComplete: true,
        versionNumber: null,
        approvedAt: null,
      },
    ]);
    const process: Studies = {
      id: created.id,
      stageId: created.currentStage?.id ?? '',
      version: created.version,
    };
    const transitionId = await workflowRef(
      created.id,
      'workflow_transitions',
      'ENVIAR_APROVACAO_DFD',
    );
    await db.admin(`
      CREATE FUNCTION test_fail_approval() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'falha induzida no teste'; END $fn$;
      CREATE TRIGGER test_fail_approval BEFORE INSERT ON approvals
        FOR EACH ROW EXECUTE FUNCTION test_fail_approval();`);
    try {
      const before = await effects(created.id);
      const failed = await forward(process, { transitionId });
      expect(failed.status).toBe(500);
      expect(await effects(created.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_approval ON approvals; DROP FUNCTION test_fail_approval();',
      );
    }
    // Sem a falha: AWAITING_APPROVAL, aprovação PENDING do titular e a concessão APPROVER.
    const ok = await forward(process, { transitionId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await effects(created.id);
    expect(after.process).toMatchObject({
      status: 'AWAITING_APPROVAL',
      current_department_id: OBRAS,
    });
    expect(after.approvals).toEqual([{ status: 'PENDING', approver_user_id: MARTA }]);
    expect(after.access).toContainEqual({
      reason: 'APPROVER',
      department_id: null,
      user_id: MARTA,
      revoked: false,
    });
    expect(after.events.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(['ApprovalRequested', 'ProcessStageChanged', 'ProcessStatusChanged']),
    );
  });

  it('[Concorrência] 20 encaminhamentos simultâneos: um 200, os demais 409 STAGE_CHANGED; uma etapa ativa e uma tramitação nova', async () => {
    const process = await processAtStudies();
    const transitionId = await workflowRef(process.id, 'workflow_transitions', 'ENVIAR_PESQUISA');
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => forward(process, { transitionId, toDepartmentId: COMPRAS })),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('STAGE_CHANGED');
    }
    const after = await effects(process.id);
    expect(after.stages.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    expect(after.movements.filter((row) => row.action === 'FORWARD')).toHaveLength(1);
    expect(after.assignments.filter((row) => row.is_active === true)).toHaveLength(1);
  });

  it('[Tenant incorreto] processo de A pelo tenant B = 404 e unidade de B = 422 REFERENCE_NOT_FOUND, sem alterar nada', async () => {
    const process = await processAtStudies();
    const transitionId = await workflowRef(process.id, 'workflow_transitions', 'ENVIAR_PESQUISA');
    const before = await effects(process.id);
    const foreign = await forward(
      process,
      { transitionId, toDepartmentId: COMPRAS },
      'sub-beto-us047',
    );
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    const unit = await forward(process, { transitionId, toDepartmentId: OBRAS_B });
    expect(unit.status).toBe(422);
    expect(
      problemDetailsSchema.parse(unit.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['toDepartmentId', 'REFERENCE_NOT_FOUND']]);
    expect(JSON.stringify(unit.body)).not.toContain('LEAK-B');
    expect(await effects(process.id)).toEqual(before);
  });
});
