// Suspender e retomar processo sobre PostgreSQL real (US-008 · Sucesso, Falha de banco, Concorrência,
// Duplicidade, Permissão, Tenant incorreto, Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais do provisionamento (workflow padrão DEC-015, feriado nacional de 12/10), o
// processo criado pelo PRC-02 e levado a uma etapa com prazo, a suspensão pelo PRC-23 e a retomada
// pelo PRC-24. Prova o CHECK de `status_before_suspension`, a transação única
// (falha induzida DEPOIS de gravar a tramitação: nada persiste), o `FOR UPDATE` com suspensões
// simultâneas, a extensão do prazo da etapa e da aprovação pendente pelos dias úteis do calendário
// do tenant, o evento `PENDING` e o processo de outro tenant sem revelar nada.
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

const A = '0192c008-0000-7000-8000-00000000010a';
const B = '0192c008-0000-7000-8000-00000000010b';
const ORG_A = '0192c008-0000-7000-8000-0000000010a0';
const ORG_B = '0192c008-0000-7000-8000-0000000010b0';
const OBRAS = '0192c008-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c008-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c008-0000-7000-8000-0000000010a3';
const ANA = '0192c008-0000-7000-8000-0000000010c1';
const PATRICIA = '0192c008-0000-7000-8000-0000000010c2';
const BETO = '0192c008-0000-7000-8000-0000000010c3';
const JULIANA = '0192c008-0000-7000-8000-0000000010c4';
const ANA_M = '0192c008-0000-7000-8000-0000000010d1';
const PATRICIA_M = '0192c008-0000-7000-8000-0000000010d2';
const JULIANA_M = '0192c008-0000-7000-8000-0000000010d4';
const SUSPEND_AT = new Date('2026-10-06T13:00:00.000Z'); // 06/10 10:00 em Brasília
const RESUME_AT = new Date('2026-10-13T18:00:00.000Z'); // 13/10 15:00 em Brasília
const DUE_09 = '2026-10-10T02:59:59.999Z'; // fim de 09/10 em Brasília
const MFA = ['pwd', 'otp'];
const REASON = 'Aguardando definição da dotação pela Secretaria de Finanças';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [JULIANA]: ['REQUISITANTE'],
  [PATRICIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us008', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us008', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us008', 'ana@a.test', true, 'Ana Souza'),
  ('${PATRICIA}', 'sub-patricia-us008', 'patricia@a.test', true, 'Patrícia Almeida'),
  ('${JULIANA}', 'sub-juliana-us008', 'juliana@a.test', true, 'Juliana Reis'),
  ('${BETO}', 'sub-beto-us008', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${PATRICIA_M}', '${A}', '${PATRICIA}', 'INTERNAL', 'ACTIVE'),
  ('${JULIANA_M}', '${A}', '${JULIANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c008-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c008-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c008-0000-7000-8000-0000000010e4', '${A}', '${JULIANA_M}', '${PLANEJAMENTO}', true);
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

describe('Feature: Suspender e retomar processo sobre PostgreSQL (US-008)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };
  const clock = { now: SUSPEND_AT };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us008' ? B : A);
  const post = (
    action: 'suspend' | 'resume',
    process: Pick<Staged, 'id' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; key?: string } = {},
  ) => {
    const subject = options.subject ?? 'sub-patricia-us008';
    return request(api.server)
      .post(`/api/v1/processes/${process.id}/${action}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  };
  const suspend = (process: Pick<Staged, 'id' | 'version'>, options = {}) =>
    post('suspend', process, { reason: REASON }, options);
  const resume = (process: Pick<Staged, 'id' | 'version'>, options = {}) =>
    post('resume', process, {}, options);
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

  /**
   * PRC-02 (Ana) e a passagem `key` ativa na Coordenadoria com Juliana responsável e prazo no fim de
   * 09/10 (dias úteis). ESTUDOS_PRELIMINARES é TASK; APROVACAO_DFD é APPROVAL.
   */
  async function staged(key = 'ESTUDOS_PRELIMINARES'): Promise<Staged> {
    clock.now = new Date('2026-09-28T13:00:00.000Z');
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us008', { amr: MFA }))
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
    clock.now = SUSPEND_AT;
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: ProcessDto }).data;
    const stageId = randomUUID();
    const workflowStage = await stageOf(created.id, key);
    const status = key === 'APROVACAO_DFD' ? 'AWAITING_APPROVAL' : 'IN_PROGRESS';
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, due_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${JULIANA}', '2026-10-01T12:00:00Z', '${DUE_09}', 5, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${PLANEJAMENTO}',
                 '${JULIANA}', 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = '${status}', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${PLANEJAMENTO}',
              current_responsible_id = '${JULIANA}', current_stage_due_at = '${DUE_09}'
        WHERE id = '${created.id}';
       COMMIT;`,
    );
    return { id: created.id, stageId, version: created.version };
  }

  /** Tudo que suspender/retomar grava (para provar o rollback). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, status_before_suspension::text, suspended_at, suspended_by_id,
                suspension_reason, current_stage_due_at, current_responsible_id, version
           FROM processes WHERE id = $1`,
        [id],
      )
    )[0],
    stages: await db.admin<Row>(
      `SELECT id, status::text, due_at, paused_at, paused_total_seconds, assignee_id, version
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [id],
    ),
    movements: await db.admin<Row>(
      `SELECT sequence, action::text, comment, status_from::text, status_to::text
         FROM process_movements WHERE process_id = $1 ORDER BY sequence`,
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
        WHERE process_id = $1 AND event_type <> 'ProcessCreated' ORDER BY occurred_at, routing_key`,
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
        { token: PROCESS_CLOCK, value: () => clock.now },
        { token: CATALOG_CLOCK, value: () => SUSPEND_AT },
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

  it('[Sucesso] suspende e retoma: status anterior, pausa, SUSPEND/RESUME, prazo estendido em 4 dias úteis, timeline, auditoria e eventos PENDING', async () => {
    const process = await staged();
    const suspended = await suspend(process);
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);

    const paused = await effects(process.id);
    expect(paused.process).toMatchObject({
      status: 'SUSPENDED',
      status_before_suspension: 'IN_PROGRESS',
      suspended_at: SUSPEND_AT,
      suspended_by_id: PATRICIA,
      suspension_reason: REASON,
      current_responsible_id: JULIANA,
      version: process.version + 1,
    });
    expect(paused.stages.find((row) => row.id === process.stageId)).toMatchObject({
      status: 'ACTIVE',
      paused_at: SUSPEND_AT,
      assignee_id: JULIANA,
    });
    expect(paused.movements.at(-1)).toMatchObject({
      action: 'SUSPEND',
      comment: REASON,
      status_from: 'IN_PROGRESS',
      status_to: 'SUSPENDED',
    });
    expect(paused.timeline.map((row) => row.type)).toContain('PROCESS_SUSPENDED');
    expect(paused.audit).toEqual([{ action: 'process.suspend' }]);
    // [Falha de integração] relay fora: o evento fica PENDING no outbox.
    expect(paused.events).toEqual([
      {
        event_type: 'ProcessStatusChanged',
        routing_key: 'process.status_changed.suspended',
        status: 'PENDING',
      },
    ]);

    clock.now = RESUME_AT;
    try {
      const resumed = await resume({ id: process.id, version: process.version + 1 });
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      expect(resumed.body).toMatchObject({
        meta: {
          extendedBy: { days: 4, slaType: 'BUSINESS' },
          newDueAt: '2026-10-17T02:59:59.999Z',
        },
      });
    } finally {
      clock.now = SUSPEND_AT;
    }
    const after = await effects(process.id);
    expect(after.process).toMatchObject({
      status: 'IN_PROGRESS',
      status_before_suspension: null,
      suspended_at: null,
      suspended_by_id: null,
      suspension_reason: null,
      current_stage_due_at: new Date('2026-10-17T02:59:59.999Z'),
    });
    expect(after.stages.find((row) => row.id === process.stageId)).toMatchObject({
      paused_at: null,
      paused_total_seconds: 622_800,
      due_at: new Date('2026-10-17T02:59:59.999Z'),
    });
    expect(after.movements.at(-1)).toMatchObject({ action: 'RESUME', status_to: 'IN_PROGRESS' });
    expect(after.timeline.map((row) => row.type)).toContain('PROCESS_RESUMED');
    expect(after.audit).toEqual([{ action: 'process.resume' }, { action: 'process.suspend' }]);
    expect(after.events.map((row) => row.routing_key)).toEqual([
      'process.status_changed.suspended',
      'process.status_changed.resumed',
    ]);
  });

  it('[Sucesso] aprovação pendente da etapa segue PENDING e tem o prazo estendido na retomada', async () => {
    const process = await staged('APROVACAO_DFD');
    const approvalId = randomUUID();
    await db.admin(
      `INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
                              requested_by_id, approver_type, approver_user_id, allow_deputy, due_at)
       VALUES ($1, $2, $3, 'PROCESS_STAGE', $4, 'Aprovação do DFD', $5, 'USER', $6, false,
               '2026-10-09T02:59:59.999Z')`,
      [approvalId, A, process.id, process.stageId, ANA, PATRICIA],
    );
    expect((await suspend(process)).status).toBe(200);
    clock.now = new Date('2026-10-08T13:00:00.000Z');
    try {
      const resumed = await resume({ id: process.id, version: process.version + 1 });
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    } finally {
      clock.now = SUSPEND_AT;
    }
    const [approval] = await db.admin<Row>(
      'SELECT status::text, due_at, version FROM approvals WHERE id = $1',
      [approvalId],
    );
    expect(approval).toMatchObject({
      status: 'PENDING',
      due_at: new Date('2026-10-14T02:59:59.999Z'),
      version: 2,
    });
    expect((await effects(process.id)).process).toMatchObject({ status: 'AWAITING_APPROVAL' });
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar a tramitação desfaz processo, pausa, tramitação, timeline, auditoria e evento', async () => {
    const process = await staged();
    await db.admin(`
      CREATE FUNCTION test_fail_suspend_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_SUSPENDED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_suspend_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_suspend_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await suspend(process);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
      expect(before.process).toMatchObject({
        status: 'IN_PROGRESS',
        status_before_suspension: null,
      });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_suspend_timeline ON process_timeline_entries; DROP FUNCTION test_fail_suspend_timeline();',
      );
    }
  });

  it('[Validação] o CHECK barra processo SUSPENDED sem status anterior', async () => {
    const process = await staged();
    await expect(
      db.admin("UPDATE processes SET status = 'SUSPENDED' WHERE id = $1", [process.id]),
    ).rejects.toThrow(/status_before_suspension|check/i);
  });

  it('[Concorrência] 5 suspensões simultâneas com o mesmo If-Match: uma 200; as demais 409/412; uma tramitação SUSPEND', async () => {
    const process = await staged();
    const responses = await Promise.all(Array.from({ length: 5 }, () => suspend(process)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      expect(['INVALID_PROCESS_STATUS', 'VERSION_CONFLICT']).toContain(
        problemDetailsSchema.parse(response.body).code,
      );
    }
    const after = await effects(process.id);
    expect(after.movements.filter((row) => row.action === 'SUSPEND')).toHaveLength(1);
    expect(after.audit).toEqual([{ action: 'process.suspend' }]);
  });

  it('[Duplicidade] reenvio com a mesma Idempotency-Key: replay 200 e uma única tramitação', async () => {
    const process = await staged();
    const key = randomUUID();
    const first = await suspend(process, { key });
    expect(first.status).toBe(200);
    const replay = await suspend(process, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const after = await effects(process.id);
    expect(after.movements.filter((row) => row.action === 'SUSPEND')).toHaveLength(1);
  });

  it('[Permissão] REQUISITANTE sem PROCESS_SUSPEND = 403 PERMISSION_DENIED com access.denied e nada alterado', async () => {
    const process = await staged();
    const before = await effects(process.id);
    const response = await suspend(process, { subject: 'sub-ana-us008' });
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    expect(await effects(process.id)).toEqual(before);
    const [denied] = await db.admin<Row>(
      "SELECT reason_code FROM audit_logs WHERE action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(denied).toMatchObject({ reason_code: 'PROCESS_SUSPEND' });
  });

  it('[Tenant incorreto] processo de A pelo tenant B = 404 PROCESS_NOT_FOUND, sem revelar nem alterar nada', async () => {
    const process = await staged();
    const before = await effects(process.id);
    const foreign = await suspend(process, { subject: 'sub-beto-us008' });
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
    expect(await effects(process.id)).toEqual(before);
  });
});
