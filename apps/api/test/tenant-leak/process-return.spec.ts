// Devolução do processo sobre PostgreSQL real (US-048 · Sucesso, Falha de banco, Concorrência,
// Tenant incorreto, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento (workflow padrão DEC-015, feriados nacionais), o processo criado pelo PRC-02 (Ana
// responsável pela ABERTURA) e levado à etapa ESTUDOS_PRELIMINARES com a Carla, e a devolução pelo
// PRC-20. Prova a transação única (falha induzida DEPOIS de gravar a nova etapa: nada persiste —
// processo, passagens, responsabilidades, tramitação, acessos, timeline, auditoria e outbox), o
// `PREVIOUS_ASSIGNEE` pelo histórico de `process_assignments`, a concessão CURRENT → HISTORICAL, o
// `FOR UPDATE` com 10 devoluções simultâneas (uma 200, as demais 409 `STAGE_CHANGED`), os eventos
// `PENDING` e o destino de outro tenant sem revelar nada.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ReturnedProcessDto } from '@contrataflow/validation';
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

const A = '0192c048-0000-7000-8000-00000000010a';
const B = '0192c048-0000-7000-8000-00000000010b';
const ORG_A = '0192c048-0000-7000-8000-0000000010a0';
const ORG_B = '0192c048-0000-7000-8000-0000000010b0';
const OBRAS = '0192c048-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c048-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c048-0000-7000-8000-0000000010a3';
const ANA = '0192c048-0000-7000-8000-0000000010c1';
const CARLA = '0192c048-0000-7000-8000-0000000010c2';
const BETO = '0192c048-0000-7000-8000-0000000010c3';
const ANA_M = '0192c048-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c048-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-05T15:00:00.000Z');
/** 13/10/2026 23:59:59 em São Paulo: 5 dias úteis (SLA da ABERTURA) sem o feriado de 12/10. */
const DUE_13_10 = '2026-10-14T02:59:59.999Z';
const REASON = 'Faltou detalhar a justificativa da contratação no DFD';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us048', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us048', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us048', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', 'sub-carla-us048', 'carla@a.test', true, 'Carla Dias'),
  ('${BETO}', 'sub-beto-us048', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c048-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c048-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c048-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${PLANEJAMENTO}', true);
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

describe('Feature: Devolver processo sobre PostgreSQL (US-048)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us048' ? B : A);
  const giveBack = (process: Studies, body: Record<string, unknown>, subject = 'sub-carla-us048') =>
    request(api.server)
      .post(`/api/v1/processes/${process.id}/return`)
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
  const stageOf = async (processId: string, key: string) => {
    const [row] = await db.admin<{ id: string }>(
      `SELECT s.id FROM workflow_stages s JOIN processes p ON p.workflow_version_id = s.workflow_version_id
        WHERE p.id = $1 AND s.key = $2`,
      [processId, key],
    );
    if (!row) throw new Error(`workflow_stages/${key} ausente`);
    return row.id;
  };

  /** PRC-02 (Ana, ABERTURA) e a passagem ESTUDOS_PRELIMINARES ativa com a Carla na Coordenadoria. */
  async function processAtStudies(): Promise<Studies> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us048', { amr: MFA }))
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
    const studies = await stageOf(created.id, 'ESTUDOS_PRELIMINARES');
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${studies}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${CARLA}', '2026-10-01T12:00:00Z', 15, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${PLANEJAMENTO}', '${CARLA}',
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${studies}', current_department_id = '${PLANEJAMENTO}',
              current_responsible_id = '${CARLA}'
        WHERE id = '${created.id}';
       UPDATE process_access SET revoked_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}' AND reason IN ('CURRENT', 'RESPONSIBLE');
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${MANUTENCAO}', NULL, 'HISTORICAL'),
                ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${PLANEJAMENTO}', NULL, 'CURRENT'),
                ('${randomUUID()}', '${A}', '${created.id}', 'USER', NULL, '${CARLA}', 'RESPONSIBLE');
       COMMIT;`,
    );
    return { id: created.id, stageId, version: created.version };
  }

  /** Tudo que a devolução grava (para provar o rollback). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, version, current_stage_id, current_workflow_stage_id,
                current_department_id, current_responsible_id, current_stage_due_at
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0],
    stages: await db.admin<Row>(
      `SELECT id, sequence, status::text, department_id, assignee_id, due_at, exited_via_movement_id
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    assignments: await db.admin<Row>(
      `SELECT process_stage_id, assignee_id, type::text, is_active FROM process_assignments
        WHERE process_id = $1 ORDER BY started_at, id`,
      [id],
    ),
    movements: await db.admin<Row>(
      'SELECT sequence, action::text FROM process_movements WHERE process_id = $1 ORDER BY sequence',
      [id],
    ),
    access: await db.admin<Row>(
      `SELECT reason::text, department_id, user_id, revoked_at IS NOT NULL AS revoked
         FROM process_access WHERE process_id = $1 ORDER BY reason, department_id, user_id, revoked`,
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
    // Elegibilidade da Ana (RN-TRAM-08: PROCESS_VIEW) lida das atribuições gravadas no banco.
    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id)
       SELECT $1, $2, $3, r.id, 'OWN_DEPARTMENTS', $4 FROM roles r WHERE r.tenant_id = $2 AND r.key = 'REQUISITANTE'`,
      [randomUUID(), A, ANA_M, CARLA],
    );
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

  it('[Sucesso] ESTUDOS → ABERTURA com a Ana (PREVIOUS_ASSIGNEE): passagens, responsabilidades, tramitação, HISTORICAL/CURRENT/RESPONSIBLE, timeline, auditoria e eventos PENDING no mesmo commit', async () => {
    const process = await processAtStudies();
    const abertura = await stageOf(process.id, 'ABERTURA');
    const response = await giveBack(process, { targetStageId: abertura, comment: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const dto = (response.body as { data: ReturnedProcessDto }).data;
    expect(response.headers.etag).toBe(`"${String(process.version + 1)}"`);
    expect(dto).toMatchObject({
      status: 'RETURNED',
      statusFrom: 'IN_PROGRESS',
      currentStage: { key: 'ABERTURA', dueAt: DUE_13_10 },
      currentResponsible: { id: ANA },
    });

    const after = await effects(process.id);
    expect(after.process).toMatchObject({
      status: 'RETURNED',
      version: process.version + 1,
      current_workflow_stage_id: abertura,
      current_department_id: MANUTENCAO,
      current_responsible_id: ANA,
    });
    // O `pg` devolve `Date`: `String(date)` descartaria os milissegundos do `23:59:59.999`.
    expect((after.process?.current_stage_due_at as Date).toISOString()).toBe(DUE_13_10);
    const [opening, studies, back, ...more] = after.stages;
    expect(more).toEqual([]);
    expect(opening).toMatchObject({ status: 'COMPLETED' });
    expect(studies).toMatchObject({
      id: process.stageId,
      status: 'RETURNED',
      exited_via_movement_id: dto.movement.id,
    });
    expect(back).toMatchObject({
      sequence: 3,
      status: 'ACTIVE',
      department_id: MANUTENCAO,
      assignee_id: ANA,
    });
    expect(after.assignments.filter((row) => row.is_active === true)).toEqual([
      { process_stage_id: back?.id, assignee_id: ANA, type: 'RETURN', is_active: true },
    ]);
    expect(after.movements).toEqual([
      { sequence: 1, action: 'CREATE' },
      { sequence: 2, action: 'RETURN' },
    ]);
    const [movement] = await db.admin<Row>(
      `SELECT from_department_id, to_department_id, from_user_id, to_user_id, actor_id, comment,
              status_from::text, status_to::text, correlation_id, documents
         FROM process_movements WHERE id = $1`,
      [dto.movement.id],
    );
    expect(movement).toMatchObject({
      from_department_id: PLANEJAMENTO,
      to_department_id: MANUTENCAO,
      from_user_id: CARLA,
      to_user_id: ANA,
      actor_id: CARLA,
      comment: REASON,
      status_from: 'IN_PROGRESS',
      status_to: 'RETURNED',
      documents: [],
    });
    expect(movement?.correlation_id).toEqual(expect.any(String));
    expect(after.access).toEqual(
      expect.arrayContaining([
        { reason: 'CURRENT', department_id: PLANEJAMENTO, user_id: null, revoked: true },
        { reason: 'HISTORICAL', department_id: PLANEJAMENTO, user_id: null, revoked: false },
        { reason: 'CURRENT', department_id: MANUTENCAO, user_id: null, revoked: false },
        { reason: 'RESPONSIBLE', department_id: null, user_id: ANA, revoked: false },
      ]),
    );
    expect(after.timeline.map((row) => row.type)).toContain('PROCESS_RETURNED');
    expect(after.audit.map((row) => row.action)).toEqual(['process.return']);
    // [Falha de integração] relay fora: os eventos ficam PENDING no outbox.
    expect(after.events).toEqual([
      { event_type: 'ProcessAssigned', routing_key: 'process.assigned', status: 'PENDING' },
      {
        event_type: 'ProcessStageChanged',
        routing_key: 'process.stage_changed.return',
        status: 'PENDING',
      },
      {
        event_type: 'ProcessStatusChanged',
        routing_key: 'process.status_changed.returned',
        status: 'PENDING',
      },
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar a nova etapa desfaz passagens, responsabilidades, tramitação, acessos, timeline, auditoria e eventos', async () => {
    const process = await processAtStudies();
    const abertura = await stageOf(process.id, 'ABERTURA');
    await db.admin(`
      CREATE FUNCTION test_fail_return_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_RETURNED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_return_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_return_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await giveBack(process, { targetStageId: abertura, comment: REASON });
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_return_timeline ON process_timeline_entries; DROP FUNCTION test_fail_return_timeline();',
      );
    }
  });

  it('[Concorrência] 10 devoluções simultâneas: uma 200, as demais 409 STAGE_CHANGED; uma etapa ativa e uma tramitação RETURN', async () => {
    const process = await processAtStudies();
    const abertura = await stageOf(process.id, 'ABERTURA');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        giveBack(process, { targetStageId: abertura, comment: REASON }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('STAGE_CHANGED');
    }
    const after = await effects(process.id);
    expect(after.stages.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    expect(after.movements.filter((row) => row.action === 'RETURN')).toHaveLength(1);
    expect(after.assignments.filter((row) => row.is_active === true)).toHaveLength(1);
  });

  it('[Tenant incorreto] processo de A pelo tenant B = 404; etapa percorrida em B como destino = 422 TRANSITION_NOT_AVAILABLE, sem revelar nem alterar nada', async () => {
    const process = await processAtStudies();
    const abertura = await stageOf(process.id, 'ABERTURA');
    const [foreignStage] = await db.admin<{ id: string }>(
      "SELECT id FROM workflow_stages WHERE tenant_id = $1 AND key = 'ABERTURA' LIMIT 1",
      [B],
    );
    if (!foreignStage) throw new Error('etapa ABERTURA do tenant B ausente');
    const before = await effects(process.id);

    const foreign = await giveBack(
      process,
      { targetStageId: abertura, comment: REASON },
      'sub-beto-us048',
    );
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');

    const target = await giveBack(process, { targetStageId: foreignStage.id, comment: REASON });
    expect(target.status).toBe(422);
    expect(problemDetailsSchema.parse(target.body).code).toBe('TRANSITION_NOT_AVAILABLE');
    expect(JSON.stringify(target.body)).not.toContain('LEAK-B');
    expect(JSON.stringify(target.body)).not.toContain(foreignStage.id);
    expect(await effects(process.id)).toEqual(before);
  });
});
