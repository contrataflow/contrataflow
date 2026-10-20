// Caixa de tarefas sobre PostgreSQL real (US-056 · TSK-01/TSK-02 + PRC-21): a API inteira como
// `cf_app` (RLS das views `security_invoker`) com os seeders reais do provisionamento (workflow
// padrão DEC-015). Prova as visões sobre as views publicadas (`v_inbox_processes`,
// `v_inbox_participations`, `v_inbox_pending_approvals`) — comigo, fila (titular/lotado com
// PROCESS_CLAIM), aprovações pendentes (direto, titular/substituto com `allowDeputy`, perfil com
// escopo do órgão), devolvidos, atrasados e acompanhando —, contadores = totais da lista
// (RN-INBOX-09), o "Assumir" de ponta a ponta (sai da fila, entra em "Comigo", `ProcessAssigned`),
// o reenvio com a mesma `Idempotency-Key`, a corrida de dois membros e o isolamento por tenant
// (mesmo usuário com processo em outro tenant; RLS das views com outro `app.tenant_id`).
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  taskInboxCountersResponseSchema,
  taskInboxResponseSchema,
} from '@contrataflow/validation';
import type { ProcessDto, TaskInboxResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { INBOX_CLOCK } from '../../src/modules/inbox/application/ports.js';
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

const A = '0192c056-0000-7000-8000-00000000010a';
const B = '0192c056-0000-7000-8000-00000000010b';
const ORG_A = '0192c056-0000-7000-8000-0000000010a0';
const ORG_B = '0192c056-0000-7000-8000-0000000010b0';
const OBRAS = '0192c056-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c056-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c056-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c056-0000-7000-8000-0000000010b1';
const MANUTENCAO_B = '0192c056-0000-7000-8000-0000000010b2';
const ANA = '0192c056-0000-7000-8000-0000000010c1';
const CARLOS = '0192c056-0000-7000-8000-0000000010c2';
const BRUNO = '0192c056-0000-7000-8000-0000000010c3';
const ELI = '0192c056-0000-7000-8000-0000000010c4';
const RUI = '0192c056-0000-7000-8000-0000000010c5';
const ANA_M = '0192c056-0000-7000-8000-0000000010d1';
const CARLOS_M = '0192c056-0000-7000-8000-0000000010d2';
const BRUNO_M = '0192c056-0000-7000-8000-0000000010d3';
const ELI_M = '0192c056-0000-7000-8000-0000000010d4';
const RUI_M = '0192c056-0000-7000-8000-0000000010d5';
const ANA_B_M = '0192c056-0000-7000-8000-0000000010d6';
const NOW = new Date('2026-10-19T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLOS]: ['REQUISITANTE'],
  [ELI]: ['REQUISITANTE'],
  [BRUNO]: ['SOMENTE_LEITURA'],
  [RUI]: ['REQUISITANTE'],
};

const SUBJECT: Readonly<Record<string, string>> = {
  [ANA]: 'sub-ana-us056',
  [CARLOS]: 'sub-carlos-us056',
  [BRUNO]: 'sub-bruno-us056',
  [ELI]: 'sub-eli-us056',
  [RUI]: 'sub-rui-us056',
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

// Ana é titular do Planejamento e substituta da Manutenção; Ana e Carlos lotados no Planejamento.
const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us056', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us056', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us056', 'ana@saojose.test', true, 'Ana Souza'),
  ('${CARLOS}', 'sub-carlos-us056', 'carlos@saojose.test', true, 'Carlos Lima'),
  ('${BRUNO}', 'sub-bruno-us056', 'bruno@saojose.test', true, 'Bruno Reis'),
  ('${ELI}', 'sub-eli-us056', 'eli@saojose.test', true, 'Eli Matos'),
  ('${RUI}', 'sub-rui-us056', 'rui@saojose.test', true, 'Rui Prado');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id, deputy_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL, '${ANA}'),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, '${ANA}', NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL, NULL),
  ('${MANUTENCAO_B}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Manutenção LEAK-B', '${path(OBRAS_B, MANUTENCAO_B)}', 1, NULL, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLOS_M}', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE'),
  ('${BRUNO_M}', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('${ELI_M}', '${A}', '${ELI}', 'INTERNAL', 'ACTIVE'),
  ('${RUI_M}', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('${ANA_B_M}', '${B}', '${ANA}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c056-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${PLANEJAMENTO}', true),
  ('0192c056-0000-7000-8000-0000000010e2', '${A}', '${CARLOS_M}', '${PLANEJAMENTO}', true),
  ('0192c056-0000-7000-8000-0000000010e3', '${A}', '${BRUNO_M}', '${MANUTENCAO}', true),
  ('0192c056-0000-7000-8000-0000000010e4', '${A}', '${ELI_M}', '${MANUTENCAO}', true),
  ('0192c056-0000-7000-8000-0000000010e5', '${A}', '${RUI_M}', '${MANUTENCAO}', true),
  ('0192c056-0000-7000-8000-0000000010e6', '${B}', '${ANA_B_M}', '${MANUTENCAO_B}', true);
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

interface Queued {
  readonly id: string;
  readonly stageId: string;
  readonly version: number;
}

describe('Feature: Caixa de tarefas unificada sobre PostgreSQL (US-056)', () => {
  let db: TestDatabase;
  let api: TestApi;
  const catalogs = new Map<string, { contractingType: string; origin: string }>();

  const auth = (call: request.Test, user: string, tenantId: string = A) =>
    call
      .set('Authorization', api.bearer(SUBJECT[user] ?? user, { amr: MFA }))
      .set('X-Tenant-Id', tenantId);
  const get = (query: string, user = ANA, tenantId: string = A) =>
    auth(request(api.server).get(`/api/v1/tasks${query}`), user, tenantId);
  const list = async (query: string, user = ANA, tenantId: string = A) => {
    const response = await get(query, user, tenantId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return taskInboxResponseSchema.parse(response.body);
  };
  const counters = async (user = ANA) => {
    const response = await get('/counters', user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return taskInboxCountersResponseSchema.parse(response.body).data;
  };
  const ids = (body: TaskInboxResponse) => body.data.map((item) => item.processId);
  const claim = (process: Queued, user = ANA, key: string | null = randomUUID()) => {
    const call = auth(request(api.server).post(`/api/v1/processes/${process.id}/claim`), user).set(
      'If-Match',
      `"${String(process.version)}"`,
    );
    if (key !== null) call.set('Idempotency-Key', key);
    return call.send();
  };

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

  /** PRC-02: o criador fica responsável pela ABERTURA (visão "Comigo"). */
  async function createProcess(user: string, tenantId: string = A): Promise<ProcessDto> {
    const catalog = catalogs.get(tenantId);
    if (!catalog) throw new Error('catálogo ausente');
    const response = await auth(request(api.server).post('/api/v1/processes'), user, tenantId)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: tenantId === A ? OBRAS : OBRAS_B,
        requestingDepartmentId: tenantId === A ? MANUTENCAO : MANUTENCAO_B,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  }

  /** O processo na etapa ESTUDOS_PRELIMINARES, na fila da unidade `department`, sem responsável. */
  async function processInQueue(department = PLANEJAMENTO): Promise<Queued> {
    const created = await createProcess(ELI);
    const stageId = randomUUID();
    const workflowStage = await stageOf(created.id, 'ESTUDOS_PRELIMINARES');
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, due_at, sla_days, sla_type)
         VALUES ('${stageId}', '${A}', '${created.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${department}', NULL, '2026-10-01T12:00:00Z', '2026-10-30T02:59:59Z', 15, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${stageId}', '${department}', NULL,
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${department}',
              current_responsible_id = NULL, current_stage_due_at = '2026-10-30T02:59:59Z'
        WHERE id = '${created.id}';
       UPDATE process_access SET revoked_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}' AND reason IN ('CURRENT', 'RESPONSIBLE');
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', 'DEPARTMENT', '${department}', NULL, 'CURRENT');
       COMMIT;`,
    );
    return { id: created.id, stageId, version: created.version };
  }

  /** Aprovação PENDING na passagem ativa do processo (como a US-051 grava). */
  async function pendingApproval(
    process: Queued,
    approver: {
      readonly type: 'USER' | 'ROLE' | 'DEPARTMENT_HEAD';
      readonly userId?: string;
      readonly roleId?: string;
      readonly departmentId?: string;
      readonly allowDeputy?: boolean;
    },
  ): Promise<string> {
    const id = randomUUID();
    await db.admin(
      `INSERT INTO approvals (id, tenant_id, process_id, subject_type, process_stage_id, title,
                              requested_by_id, requested_at, approver_type, approver_user_id,
                              approver_role_id, approver_department_id, allow_deputy, due_at)
       VALUES ($1, $2, $3, 'PROCESS_STAGE', $4, 'Aprovação do estudo', $5, '2026-10-12T12:00:00Z',
               $6::approver_type, $7, $8, $9, $10, '2026-10-24T02:59:59Z')`,
      [
        id,
        A,
        process.id,
        process.stageId,
        ELI,
        approver.type,
        approver.userId ?? null,
        approver.roleId ?? null,
        approver.departmentId ?? null,
        approver.allowDeputy ?? false,
      ],
    );
    return id;
  }

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
        { token: INBOX_CLOCK, value: () => NOW },
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
    for (const tenantId of [A, B]) {
      await runTenantSeeders(api, tenantId, [
        'catalog.items',
        'catalog.holidays',
        'access.defaultRoles',
        'document.systemTypes',
        'workflow.seedWorkflows',
      ]);
      catalogs.set(tenantId, {
        contractingType: await catalogId(tenantId, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        origin: await catalogId(tenantId, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      });
    }
    // Rui decide por perfil: AUTORIDADE_COMPETENTE gravada com escopo do órgão A (US-096).
    const [authority] = await db.admin<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND key = 'AUTORIDADE_COMPETENTE'",
      [A],
    );
    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type,
                                     scope_organization_id, include_subtree, valid_from, granted_by_id)
       VALUES ($1, $2, $3, $4, 'ORGANIZATION', $5, true, '2026-01-01T00:00:00Z', $6)`,
      [randomUUID(), A, RUI_M, authority?.id, ORG_A, ANA],
    );
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] Ver os processos sob minha responsabilidade: exatamente os 3 e o contador 3', async () => {
    const created = [await createProcess(ELI), await createProcess(ELI), await createProcess(ELI)];
    const body = await list('?view=MINE&pageSize=100', ELI);
    expect(ids(body).sort()).toEqual(created.map((process) => process.id).sort());
    expect(body.meta.totalItems).toBe(3);
    expect((await counters(ELI)).mine).toBe(3);
  });

  it('[Sucesso] Assumir da fila: sai de "Na fila da minha unidade", entra em "Comigo" e gera ProcessAssigned', async () => {
    const process = await processInQueue();
    const before = await counters();
    const queue = await list('?view=UNIT_QUEUE&pageSize=100');
    const row = queue.data.find((item) => item.processId === process.id);
    expect(row).toMatchObject({
      canClaim: true,
      currentResponsible: null,
      currentDepartment: { id: PLANEJAMENTO, name: 'Coordenadoria de Planejamento' },
      currentStage: { key: 'ESTUDOS_PRELIMINARES' },
      version: process.version,
      dueAt: '2026-10-30T02:59:59.000Z',
    });

    const response = await claim(process);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: ProcessDto }).data.currentResponsible?.id).toBe(ANA);
    expect(ids(await list('?view=UNIT_QUEUE&pageSize=100'))).not.toContain(process.id);
    expect(ids(await list('?view=MINE&pageSize=100'))).toContain(process.id);
    const after = await counters();
    expect(after.unitQueue).toBe((before.unitQueue ?? 0) - 1);
    expect(after.mine).toBe(before.mine + 1);
    const events = await db.admin<Row>(
      "SELECT event_type FROM outbox_events WHERE process_id = $1 AND event_type = 'ProcessAssigned'",
      [process.id],
    );
    expect(events).toHaveLength(1);
  });

  it('[Duplicidade] reenvio do "Assumir" com a mesma chave: 200 com o mesmo resultado e Idempotent-Replayed', async () => {
    const process = await processInQueue();
    const k1 = randomUUID();
    const first = await claim(process, ANA, k1);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await claim(process, ANA, k1);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const claims = await db.admin<Row>(
      "SELECT 1 FROM process_movements WHERE process_id = $1 AND action = 'CLAIM'",
      [process.id],
    );
    expect(claims).toHaveLength(1);
  });

  it('[Concorrência] Ana e Carlos assumem quase ao mesmo tempo: um 200, o outro 409 PROCESS_ALREADY_ASSIGNED', async () => {
    const process = await processInQueue();
    const responses = await Promise.all([claim(process, ANA), claim(process, CARLOS)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const refused = responses.find((response) => response.status === 409);
    expect(problemDetailsSchema.parse(refused?.body).code).toBe('PROCESS_ALREADY_ASSIGNED');
    const winner = responses.find((response) => response.status === 200);
    const winnerId = (winner?.body as { data: ProcessDto }).data.currentResponsible?.id;
    const loser = winnerId === ANA ? CARLOS : ANA;
    expect(ids(await list('?view=MINE&pageSize=100', winnerId))).toContain(process.id);
    expect(ids(await list('?view=UNIT_QUEUE&pageSize=100', loser))).not.toContain(process.id);
  });

  it('[Sucesso] aprovações pendentes por cobertura POL-03 (direto, titular, substituto com allowDeputy, perfil)', async () => {
    // Uma aprovação pendente por passagem (approvals_pending_stage_key): um processo por caso.
    const [authority] = await db.admin<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND key = 'AUTORIDADE_COMPETENTE'",
      [A],
    );
    const approvalOn = async (approver: Parameters<typeof pendingApproval>[1]) => {
      const process = await processInQueue(MANUTENCAO);
      // A Ana não é da Manutenção: vê o processo pela concessão de aprovadora (US-051).
      await db.admin(
        `INSERT INTO process_access (id, tenant_id, process_id, principal_type, user_id, reason)
         VALUES ($1, $2, $3, 'USER', $4, 'APPROVER')`,
        [randomUUID(), A, process.id, ANA],
      );
      return { process, id: await pendingApproval(process, approver) };
    };
    const direct = (await approvalOn({ type: 'USER', userId: ANA })).id;
    const asHead = (await approvalOn({ type: 'DEPARTMENT_HEAD', departmentId: PLANEJAMENTO })).id;
    const deputyDenied = (await approvalOn({ type: 'DEPARTMENT_HEAD', departmentId: MANUTENCAO }))
      .id;
    const deputyAllowed = (
      await approvalOn({ type: 'DEPARTMENT_HEAD', departmentId: MANUTENCAO, allowDeputy: true })
    ).id;
    if (!authority) throw new Error('perfil AUTORIDADE_COMPETENTE ausente');
    const byRole = await approvalOn({ type: 'ROLE', roleId: authority.id });
    const ana = await list('?view=PENDING_APPROVALS&pageSize=100');
    const anaRows = ana.data.map((item) => item.id);
    expect(anaRows.sort()).toEqual([direct, asHead, deputyAllowed].sort());
    expect(anaRows).not.toContain(deputyDenied);
    expect(ana.data.find((item) => item.id === direct)).toMatchObject({
      dueAt: '2026-10-24T02:59:59.000Z',
      approval: {
        id: direct,
        subjectType: 'PROCESS_STAGE',
        title: 'Aprovação do estudo',
        requestedBy: { id: ELI, name: 'Eli Matos' },
        requestedAt: '2026-10-12T12:00:00.000Z',
      },
    });
    const rui = await list('?view=PENDING_APPROVALS&pageSize=100', RUI);
    expect(rui.data.map((item) => item.id)).toEqual([byRole.id]);
    expect(rui.data[0]?.processId).toBe(byRole.process.id);
    expect((await list('?view=PENDING_APPROVALS&pageSize=100', CARLOS)).data).toEqual([]);
  });

  it('[Sucesso] devolvidos, atrasados e acompanhando; contadores = totais da lista (mesmos predicados)', async () => {
    const returned = await processInQueue();
    await db.admin(
      "UPDATE process_assignments SET type = 'RETURN' WHERE process_id = $1 AND is_active",
      [returned.id],
    );
    const late = await processInQueue();
    await db.admin(
      "UPDATE process_stages SET overdue_since = '2026-10-16T03:00:00Z' WHERE id = $1",
      [late.stageId],
    );
    const followed = await processInQueue(MANUTENCAO);
    const participant = randomUUID();
    await db.admin(
      `INSERT INTO process_participants (id, tenant_id, process_id, user_id, role, granted_by_id)
       VALUES ($1, $2, $3, $4, 'OBSERVER', $5)`,
      [participant, A, followed.id, BRUNO, ANA],
    );
    await db.admin(
      `INSERT INTO process_access (id, tenant_id, process_id, principal_type, user_id, reason, source_id)
       VALUES ($1, $2, $3, 'USER', $4, 'PARTICIPANT', $5)`,
      [randomUUID(), A, followed.id, BRUNO, participant],
    );
    expect(ids(await list('?view=RETURNED&pageSize=100'))).toContain(returned.id);
    const overdue = await list('?view=OVERDUE&pageSize=100');
    expect(ids(overdue)).toContain(late.id);
    expect(overdue.data.find((item) => item.processId === late.id)?.isOverdue).toBe(true);
    expect(ids(overdue)).not.toContain(returned.id);
    expect(ids(await list('?view=FOLLOWING&pageSize=100', BRUNO))).toEqual([followed.id]);

    for (const user of [ANA, BRUNO, RUI]) {
      const all = await counters(user);
      for (const [view, key] of [
        ['MINE', 'mine'],
        ['UNIT_QUEUE', 'unitQueue'],
        ['PENDING_APPROVALS', 'pendingApprovals'],
        ['RETURNED', 'returned'],
        ['OVERDUE', 'overdue'],
        ['FOLLOWING', 'following'],
      ] as const) {
        const total = (await list(`?view=${view}&pageSize=1`, user)).meta.totalItems;
        expect(all[key] ?? 0, `${user}/${view}`).toBe(total);
      }
    }
  });

  it('[Permissão] sem PROCESS_CLAIM e sem titularidade: sem a fila da unidade (contador ausente e lista vazia)', async () => {
    await processInQueue(MANUTENCAO);
    expect(await counters(BRUNO)).not.toHaveProperty('unitQueue');
    expect((await list('?view=UNIT_QUEUE', BRUNO)).data).toEqual([]);
    // Lotado com PROCESS_CLAIM (Rui, na Manutenção) vê a fila da unidade.
    expect((await counters(RUI)).unitQueue).toBeGreaterThan(0);
  });

  it('[Validação] sort inválido para a visão → 422 INVALID_ENUM em sort', async () => {
    const response = await get('?view=MINE&sort=invalidField');
    expect(response.status).toBe(422);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID_ENUM' });
  });

  it('[Tenant incorreto] processo do mesmo usuário em outro tenant nunca aparece; RLS das views isola', async () => {
    const foreign = await createProcess(ANA, B);
    // Em B, o processo é da Ana (prova que a linha existe).
    expect(ids(await list('?view=MINE&pageSize=100', ANA, B))).toEqual([foreign.id]);
    for (const view of ['MINE', 'UNIT_QUEUE', 'PENDING_APPROVALS', 'FOLLOWING', 'OVERDUE']) {
      const body = await list(`?view=${view}&pageSize=100`);
      expect(ids(body)).not.toContain(foreign.id);
      expect(JSON.stringify(body)).not.toContain('LEAK-B');
    }
    const client = db.client('cf_app');
    try {
      const seen = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM v_inbox_processes WHERE tenant_id = ${A}::uuid
              UNION ALL SELECT process_id FROM v_inbox_pending_approvals WHERE tenant_id = ${A}::uuid
              UNION ALL SELECT process_id FROM v_inbox_participations WHERE tenant_id = ${A}::uuid`,
        ),
      );
      expect(seen).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
