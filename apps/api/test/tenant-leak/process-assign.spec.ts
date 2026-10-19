// Atribuir/reatribuir responsável sobre PostgreSQL real (US-050 · Sucesso, Falha de banco,
// Concorrência, Duplicidade, Permissão, Tenant incorreto, Falha de integração): a API inteira como
// `cf_app` (RLS) com os seeders reais do provisionamento (workflow padrão DEC-015), o processo criado
// pelo PRC-02 e levado a uma etapa da Coordenadoria com a Ana responsável, e a atribuição pelo
// PRC-22. Prova a transação única (falha induzida DEPOIS de gravar a tramitação: nada persiste), o
// `FOR UPDATE` com reatribuições simultâneas (uma 200, as demais 412), a titularidade lida da
// unidade, o evento `PENDING` e o `assigneeId` de outro tenant sem revelar nada.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
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

const A = '0192c050-0000-7000-8000-00000000010a';
const B = '0192c050-0000-7000-8000-00000000010b';
const ORG_A = '0192c050-0000-7000-8000-0000000010a0';
const ORG_B = '0192c050-0000-7000-8000-0000000010b0';
const OBRAS = '0192c050-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c050-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c050-0000-7000-8000-0000000010a3';
const ANA = '0192c050-0000-7000-8000-0000000010c1';
const CARLA = '0192c050-0000-7000-8000-0000000010c2';
const BETO = '0192c050-0000-7000-8000-0000000010c3';
const DANI = '0192c050-0000-7000-8000-0000000010c4';
const RENATA = '0192c050-0000-7000-8000-0000000010c5';
const ANA_M = '0192c050-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c050-0000-7000-8000-0000000010d2';
const DANI_M = '0192c050-0000-7000-8000-0000000010d4';
const RENATA_M = '0192c050-0000-7000-8000-0000000010d5';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const REASON = 'Ana está de férias';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [DANI]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [RENATA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

// Carla (lotada só na Manutenção) é a titular da Coordenadoria de Planejamento.
const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us050', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us050', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us050', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', 'sub-carla-us050', 'carla@a.test', true, 'Carla Dias'),
  ('${DANI}', 'sub-dani-us050', 'dani@a.test', true, 'Dani Alves'),
  ('${RENATA}', 'sub-renata-us050', 'renata@a.test', true, 'Renata Lima'),
  ('${BETO}', 'sub-beto-us050', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, '${CARLA}');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('${DANI_M}', '${A}', '${DANI}', 'INTERNAL', 'ACTIVE'),
  ('${RENATA_M}', '${A}', '${RENATA}', 'INTERNAL', 'ACTIVE'),
  ('0192c050-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c050-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${PLANEJAMENTO}', true),
  ('0192c050-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true),
  ('0192c050-0000-7000-8000-0000000010e4', '${A}', '${DANI_M}', '${PLANEJAMENTO}', true),
  ('0192c050-0000-7000-8000-0000000010e5', '${A}', '${RENATA_M}', '${OBRAS}', true);
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

interface Assigned {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Atribuir e reatribuir responsável sobre PostgreSQL (US-050)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us050' ? B : A);
  const assign = (process: Assigned, body: Record<string, unknown>, subject = 'sub-renata-us050') =>
    request(api.server)
      .post(`/api/v1/processes/${process.id}/assign`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${String(process.version)}"`)
      .send(body);
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

  /** PRC-02 (Ana, ABERTURA) e a passagem ESTUDOS_PRELIMINARES (TASK) da Coordenadoria com a Ana. */
  async function processWithAna(): Promise<Assigned> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us050', { amr: MFA }))
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
    const workflowStage = await stageOf(created.id, 'ESTUDOS_PRELIMINARES');
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${ANA}', '2026-10-01T12:00:00Z', 15, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${PLANEJAMENTO}', '${ANA}',
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${PLANEJAMENTO}',
              current_responsible_id = '${ANA}'
        WHERE id = '${created.id}';
       UPDATE process_access SET revoked_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}' AND reason = 'CURRENT';
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${MANUTENCAO}', NULL, 'HISTORICAL'),
                ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${PLANEJAMENTO}', NULL, 'CURRENT');
       COMMIT;`,
    );
    return { id: created.id, stageId, version: created.version };
  }

  /** Tudo que a atribuição grava (para provar o rollback). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, version, current_stage_id, current_department_id, current_responsible_id
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0],
    stages: await db.admin<Row>(
      `SELECT id, sequence, status::text, department_id, assignee_id, version
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    assignments: await db.admin<Row>(
      `SELECT process_stage_id, assignee_id, type::text, assigned_by_id, is_active
         FROM process_assignments WHERE process_id = $1 ORDER BY started_at, id`,
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

  it('[Sucesso] Ana → Dani: mesma passagem, MANUAL com o autor, tramitação ASSIGN com o motivo, RESPONSIBLE, timeline, auditoria e ProcessAssigned PENDING no mesmo commit', async () => {
    const process = await processWithAna();
    const before = await effects(process.id);
    const response = await assign(process, { assigneeId: DANI, reason: REASON });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers.etag).toBe(`"${String(process.version + 1)}"`);
    expect((response.body as { data: ProcessDto }).data).toMatchObject({
      currentResponsible: { id: DANI },
      version: process.version + 1,
    });

    const after = await effects(process.id);
    expect(after.process).toMatchObject({
      status: 'IN_PROGRESS',
      version: process.version + 1,
      current_stage_id: process.stageId,
      current_department_id: PLANEJAMENTO,
      current_responsible_id: DANI,
    });
    expect(after.stages).toHaveLength(before.stages.length);
    expect(after.stages.find((row) => row.id === process.stageId)).toMatchObject({
      status: 'ACTIVE',
      assignee_id: DANI,
    });
    expect(after.assignments.filter((row) => row.is_active === true)).toEqual([
      {
        process_stage_id: process.stageId,
        assignee_id: DANI,
        type: 'MANUAL',
        assigned_by_id: RENATA,
        is_active: true,
      },
    ]);
    expect(after.movements).toEqual([
      { sequence: 1, action: 'CREATE' },
      { sequence: 2, action: 'ASSIGN' },
    ]);
    const [movement] = await db.admin<Row>(
      `SELECT from_user_id, to_user_id, actor_id, comment
         FROM process_movements WHERE process_id = $1 AND action = 'ASSIGN'`,
      [process.id],
    );
    expect(movement).toEqual({
      from_user_id: ANA,
      to_user_id: DANI,
      actor_id: RENATA,
      comment: REASON,
    });
    expect(after.access).toEqual(
      expect.arrayContaining([
        { reason: 'CURRENT', department_id: PLANEJAMENTO, user_id: null, revoked: false },
        { reason: 'RESPONSIBLE', department_id: null, user_id: DANI, revoked: false },
      ]),
    );
    expect(after.timeline.map((row) => row.type)).toContain('PROCESS_ASSIGNED');
    expect(after.audit.map((row) => row.action)).toEqual(['process.assign']);
    // [Falha de integração] relay fora: o evento fica PENDING no outbox.
    expect(after.events).toEqual([
      { event_type: 'ProcessAssigned', routing_key: 'process.assigned', status: 'PENDING' },
    ]);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar a tramitação desfaz tudo e a Ana segue responsável', async () => {
    const process = await processWithAna();
    await db.admin(`
      CREATE FUNCTION test_fail_assign_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_ASSIGNED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_assign_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_assign_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await assign(process, { assigneeId: DANI, reason: REASON });
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
      expect(before.process).toMatchObject({ current_responsible_id: ANA });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_assign_timeline ON process_timeline_entries; DROP FUNCTION test_fail_assign_timeline();',
      );
    }
  });

  it('[Concorrência] 6 reatribuições simultâneas (gestora e titular): uma 200, as demais 412 VERSION_CONFLICT; uma responsabilidade ativa', async () => {
    const process = await processWithAna();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        index % 2 === 0
          ? assign(process, { assigneeId: DANI, reason: REASON })
          : assign(process, { assigneeId: null, reason: REASON }, 'sub-carla-us050'),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      expect(response.status).toBe(412);
      expect(problemDetailsSchema.parse(response.body).code).toBe('VERSION_CONFLICT');
    }
    const after = await effects(process.id);
    expect(after.process).toMatchObject({ version: process.version + 1 });
    expect(after.movements.filter((row) => row.action === 'ASSIGN')).toHaveLength(1);
    expect(after.assignments.filter((row) => row.is_active === true)).toHaveLength(1);
    expect(after.audit).toEqual([{ action: 'process.assign' }]);
  });

  it('[Duplicidade] reenvio com o If-Match já consumido = 412 VERSION_CONFLICT, uma única tramitação ASSIGN', async () => {
    const process = await processWithAna();
    expect((await assign(process, { assigneeId: DANI, reason: REASON })).status).toBe(200);
    const second = await assign(process, { assigneeId: DANI, reason: REASON });
    expect(second.status).toBe(412);
    expect(problemDetailsSchema.parse(second.body).code).toBe('VERSION_CONFLICT');
    const after = await effects(process.id);
    expect(after.movements.filter((row) => row.action === 'ASSIGN')).toHaveLength(1);
    expect(after.process).toMatchObject({ current_responsible_id: DANI });
  });

  it('[Permissão] sem PROCESS_ASSIGN nem chefia = 403 com access.denied; a titular da unidade (lida no banco) atribui', async () => {
    const process = await processWithAna();
    const before = await effects(process.id);
    const denied = await assign(process, { assigneeId: DANI, reason: REASON }, 'sub-ana-us050');
    expect(denied.status).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    expect(await effects(process.id)).toEqual(before);
    const [audit] = await db.admin<Row>(
      "SELECT reason_code FROM audit_logs WHERE action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(audit).toMatchObject({ reason_code: 'PROCESS_ASSIGN' });

    const head = await assign(process, { assigneeId: null, reason: REASON }, 'sub-carla-us050');
    expect(head.status, JSON.stringify(head.body)).toBe(200);
    const [assigned] = await db.admin<Row>(
      "SELECT metadata->>'viaHeadOrDeputy' AS via FROM audit_logs WHERE process_id = $1 AND action = 'process.assign'",
      [process.id],
    );
    expect(assigned).toEqual({ via: 'true' });
    expect((await effects(process.id)).process).toMatchObject({ current_responsible_id: null });
  });

  it('[Tenant incorreto] assigneeId de usuário só do tenant B = 422 REFERENCE_NOT_FOUND sem revelar nada; processo de A pelo B = 404', async () => {
    const process = await processWithAna();
    const before = await effects(process.id);
    const foreignAssignee = await assign(process, { assigneeId: BETO, reason: REASON });
    expect(foreignAssignee.status).toBe(422);
    const body = problemDetailsSchema.parse(foreignAssignee.body);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([
      expect.objectContaining({ field: 'assigneeId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(foreignAssignee.body)).not.toContain('LEAK-B');
    expect(await effects(process.id)).toEqual(before);

    const foreign = await assign(process, { assigneeId: DANI, reason: REASON }, 'sub-beto-us050');
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('Ana Souza');
    expect(await effects(process.id)).toEqual(before);
  });
});
