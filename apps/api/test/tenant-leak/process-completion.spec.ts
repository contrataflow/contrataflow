// Concluir processo sobre PostgreSQL real (US-010 · Sucesso, Falha de banco, Concorrência,
// Duplicidade, Permissão, Tenant incorreto, Falha de integração): a API inteira como `cf_app` (RLS)
// com os seeders reais do provisionamento (workflow padrão DEC-015), o processo criado pelo PRC-02 e
// levado à etapa END "Planejamento da contratação concluído" ainda ativa (FA-03 — a confirmação sem
// transição nomeada), sob custódia de Carla, e a conclusão pelo PRC-26. Prova a gravação de
// `completed_at`/`completed_by_id`, a passagem END encerrada (`exited_at = completed_at`), a
// tramitação `COMPLETE`, a transação única (falha induzida na timeline: nada persiste), o
// `FOR UPDATE` com conclusões simultâneas, os eventos `PENDING` e o processo de outro tenant sem
// revelar nada. A conclusão pela transição `COMPLETE` grava pelo mesmo `recordStageTransition` da
// aprovação final (test/tenant-leak/approval-decision.spec.ts).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { completedProcessSchema, problemDetailsSchema } from '@contrataflow/validation';
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

const A = '0192c010-0000-7000-8000-00000000010a';
const B = '0192c010-0000-7000-8000-00000000010b';
const ORG_A = '0192c010-0000-7000-8000-0000000010a0';
const ORG_B = '0192c010-0000-7000-8000-0000000010b0';
const OBRAS = '0192c010-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c010-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c010-0000-7000-8000-0000000010a3';
const ANA = '0192c010-0000-7000-8000-0000000010c1';
const CARLA = '0192c010-0000-7000-8000-0000000010c2';
const BETO = '0192c010-0000-7000-8000-0000000010c3';
const JULIANA = '0192c010-0000-7000-8000-0000000010c4';
const ANA_M = '0192c010-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c010-0000-7000-8000-0000000010d2';
const JULIANA_M = '0192c010-0000-7000-8000-0000000010d4';
const NOW = new Date('2026-10-20T13:00:00.000Z');
const MFA = ['pwd', 'otp'];
const COMMENT = 'Planejamento pronto para a seleção do fornecedor';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [JULIANA]: ['REQUISITANTE'],
  [CARLA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us010', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us010', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us010', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', 'sub-carla-us010', 'carla@a.test', true, 'Carla Mendes'),
  ('${JULIANA}', 'sub-juliana-us010', 'juliana@a.test', true, 'Juliana Reis'),
  ('${BETO}', 'sub-beto-us010', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('${JULIANA_M}', '${A}', '${JULIANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c010-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c010-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c010-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${PLANEJAMENTO}', true),
  ('0192c010-0000-7000-8000-0000000010e4', '${A}', '${JULIANA_M}', '${PLANEJAMENTO}', true);
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

describe('Feature: Concluir processo sobre PostgreSQL (US-010)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

  const tenantOf = (subject: string) => (subject === 'sub-beto-us010' ? B : A);
  const as = (call: request.Test, subject: string) =>
    call
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const complete = (
    process: Pick<Staged, 'id' | 'version'>,
    options: { subject?: string; key?: string } = {},
  ) =>
    as(
      request(api.server).post(`/api/v1/processes/${process.id}/complete`),
      options.subject ?? 'sub-carla-us010',
    )
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({ comment: COMMENT });
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
    const response = await as(request(api.server).post('/api/v1/processes'), 'sub-ana-us010')
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

  /** O processo IN_PROGRESS na etapa END (CONCLUSAO) ainda ativa, com Carla responsável. */
  async function atEndStage(): Promise<Staged> {
    const process = await created();
    const stageId = randomUUID();
    const workflowStage = await stageOf(process.id, 'CONCLUSAO');
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${process.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${process.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_type)
         VALUES ('${stageId}', '${A}', '${process.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${PLANEJAMENTO}', '${CARLA}', '2026-10-01T12:00:00Z', 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${process.id}', '${stageId}', '${PLANEJAMENTO}',
                 '${CARLA}', 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${PLANEJAMENTO}',
              current_responsible_id = '${CARLA}', current_stage_due_at = NULL
        WHERE id = '${process.id}';
       COMMIT;`,
    );
    return { id: process.id, stageId, version: process.version };
  }

  /** Tudo que a conclusão grava (para provar o rollback e a recusa). */
  const effects = async (id: string) => ({
    process: (
      await db.admin<Row>(
        `SELECT status::text, completed_at, completed_by_id, current_responsible_id, version
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
      `SELECT id, sequence, action::text, comment, status_from::text, status_to::text
         FROM process_movements WHERE process_id = $1 ORDER BY sequence`,
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

  it('[Sucesso] conclui: COMPLETED com completed_at/completed_by_id, passagem END encerrada, tramitação COMPLETE, timeline, auditoria e eventos PENDING', async () => {
    const process = await atEndStage();
    const response = await complete(process);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(completedProcessSchema.parse((response.body as { data: unknown }).data)).toMatchObject({
      status: 'COMPLETED',
      completedAt: NOW.toISOString(),
      completedBy: { id: CARLA, name: 'Carla Mendes' },
    });

    const after = await effects(process.id);
    expect(after.process).toMatchObject({
      status: 'COMPLETED',
      completed_at: NOW,
      completed_by_id: CARLA,
      // RN-PROC-116: o responsável fica como referência histórica.
      current_responsible_id: CARLA,
      version: process.version + 1,
    });
    const [movement] = after.movements.filter((row) => row.action === 'COMPLETE');
    expect(movement).toMatchObject({
      comment: COMMENT,
      status_from: 'IN_PROGRESS',
      status_to: 'COMPLETED',
    });
    expect(after.stages.find((row) => row.id === process.stageId)).toMatchObject({
      status: 'COMPLETED',
      exited_at: NOW,
      exited_via_movement_id: movement?.id,
    });
    expect(after.stages.some((row) => row.status === 'ACTIVE')).toBe(false);
    expect(after.assignments.every((row) => row.is_active === false)).toBe(true);
    expect(after.timeline.map((row) => row.type)).toContain('PROCESS_COMPLETED');
    expect(after.audit).toEqual([{ action: 'process.complete' }]);
    // [Falha de integração] relay fora: os eventos ficam PENDING no outbox.
    expect(after.events).toEqual([
      {
        event_type: 'ProcessStageChanged',
        routing_key: 'process.stage_changed.complete',
        status: 'PENDING',
      },
      {
        event_type: 'ProcessStatusChanged',
        routing_key: 'process.status_changed.completed',
        status: 'PENDING',
      },
    ]);
  });

  it('[Falha de banco] falha induzida na timeline DEPOIS de gravar a conclusão desfaz tudo', async () => {
    const process = await atEndStage();
    await db.admin(`
      CREATE FUNCTION test_fail_complete_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_COMPLETED' THEN RAISE EXCEPTION 'falha induzida no teste'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_complete_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_complete_timeline();`);
    try {
      const before = await effects(process.id);
      const failed = await complete(process);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual(before);
      expect(before.process).toMatchObject({ status: 'IN_PROGRESS', completed_at: null });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_complete_timeline ON process_timeline_entries; DROP FUNCTION test_fail_complete_timeline();',
      );
    }
  });

  it('[Concorrência] 5 conclusões simultâneas com o mesmo If-Match: uma 200; as demais 412; uma tramitação COMPLETE', async () => {
    const process = await atEndStage();
    const responses = await Promise.all(Array.from({ length: 5 }, () => complete(process)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('VERSION_CONFLICT');
    }
    const after = await effects(process.id);
    expect(after.movements.filter((row) => row.action === 'COMPLETE')).toHaveLength(1);
    expect(after.audit).toEqual([{ action: 'process.complete' }]);
  });

  it('[Duplicidade] reenvio com a mesma Idempotency-Key: a mesma resposta (Idempotent-Replayed) e nada novo', async () => {
    const process = await atEndStage();
    const key = randomUUID();
    const first = await complete(process, { key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const after = await effects(process.id);
    const again = await complete(process, { key });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await effects(process.id)).toEqual(after);
  });

  it('[Permissão] REQUISITANTE sem PROCESS_COMPLETE = 403 PERMISSION_DENIED com access.denied e nada alterado', async () => {
    const process = await atEndStage();
    const before = await effects(process.id);
    const response = await complete(process, { subject: 'sub-juliana-us010' });
    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    const after = await effects(process.id);
    expect({ ...after, audit: before.audit }).toEqual(before);
    const [denied] = await db.admin<Row>(
      "SELECT reason_code FROM audit_logs WHERE action = 'access.denied' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(denied).toMatchObject({ reason_code: 'PROCESS_COMPLETE' });
  });

  it('[Tenant incorreto] processo de A pelo tenant B = 404 PROCESS_NOT_FOUND, sem revelar nem alterar nada', async () => {
    const process = await atEndStage();
    const before = await effects(process.id);
    const foreign = await complete(process, { subject: 'sub-beto-us010' });
    expect(foreign.status).toBe(404);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe('PROCESS_NOT_FOUND');
    expect(JSON.stringify(foreign.body)).not.toContain('LEAK-B');
    expect(await effects(process.id)).toEqual(before);
  });
});
