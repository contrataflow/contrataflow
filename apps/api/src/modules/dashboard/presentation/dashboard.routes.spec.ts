import {
  DASHBOARD_WIDGET_KEYS,
  dashboardSummaryResponseSchema,
  dashboardWidgetResponseSchema,
  problemDetailsSchema,
  taskInboxCountersResponseSchema,
} from '@contrataflow/validation';
import type { DashboardWidgetOf } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore, InMemoryCacheStore } from '#shared/cache/cache-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  INBOX_READER,
  InMemoryInboxReader,
  seedMember,
} from '../../../../test/support/dashboard-fixtures.js';
import type { InboxProcessRow } from '../../../../test/support/dashboard-fixtures.js';
import { CATALOG_CLOCK, runTenantSeeders } from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { DASHBOARD_CLOCK, DASHBOARD_READER, DASHBOARD_TRANSACTIONS } from '../application/ports.js';
import type { DashboardTransactions } from '../application/ports.js';
import type { DashboardActivityRow, DashboardProcessRow } from '../domain/dashboard.js';
import { InMemoryDashboardReader } from '../infrastructure/dashboard.readers.js';

/*
 * US-076 — DSH-01/DSH-02 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização
 * `DASHBOARD_VIEW`, validação Zod, filtro RFC 9457) com a identidade fake e os leitores em memória
 * (os predicados puros do domínio). Personas do Gherkin: "Ana" = uma gestora com perfil em escopo
 * TENANT SEM `PROCESS_VIEW_CONFIDENTIAL_BUDGET`; Lúcia (GESTOR_CONTRATACOES, com a permissão de
 * orçamento sigiloso); "Bruno" = membro com um perfil só de consulta de processos (sem
 * `DASHBOARD_VIEW`); "Carla" = Ana do diretório fake (REQUISITANTE, `PROCESS_VIEW` só das lotações —
 * Secretaria de Obras). O SQL, a RLS das views, a consistência com TSK-02 sobre PostgreSQL e a concorrência real
 * estão em `test/tenant-leak/dashboard.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
// Terça, 20/10/2026, 12:00 em Brasília.
const NOW = new Date('2026-10-20T15:00:00.000Z');
const ORG = '0192e076-0000-7000-8000-0000000000a0';
const OBRAS = '0192e076-0000-7000-8000-0000000000a1';
const MANUT = '0192e076-0000-7000-8000-0000000000a2';
const SAUDE = '0192e076-0000-7000-8000-0000000000a3';
const SAUDE_SETOR = '0192e076-0000-7000-8000-0000000000a4';
const INATIVA = '0192e076-0000-7000-8000-0000000000a5';
const SETOR_Y = '0192e076-0000-7000-8000-0000000000b1';
const STAGE = '0192e076-0000-7000-8000-0000000000e1';
// "Ana" do Gherkin (gestão em escopo TENANT, sem orçamento sigiloso) e "Bruno" (sem o painel).
const GESTORA = '0192e076-0000-7000-8000-0000000000c1';
const GESTORA_M = '0192e076-0000-7000-8000-0000000000d1';
const BRUNO = '0192e076-0000-7000-8000-0000000000c2';
const BRUNO_M = '0192e076-0000-7000-8000-0000000000d2';
// "Carla" do Gherkin: Ana do diretório fake (REQUISITANTE, lotada na Secretaria de Obras).
const ANA = FAKE_USERS.ana.id;

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';
const pid = (n: number) => `0192e076-0000-7000-8000-${String(n).padStart(12, '0')}`;

function processRow(n: number, patch: Partial<DashboardProcessRow> = {}): DashboardProcessRow {
  return {
    tenantId: A,
    id: pid(n),
    organizationId: ORG,
    code: `${String(n).padStart(4, '0')}/2026`,
    status: 'IN_PROGRESS',
    isBudgetConfidential: false,
    estimatedValue: '10000.00',
    requestingSecretariatId: OBRAS,
    requestingDepartmentId: MANUT,
    currentDepartmentId: MANUT,
    currentResponsibleId: null,
    currentWorkflowStageId: STAGE,
    currentStageDueAt: new Date('2026-11-30T02:59:59.999Z'),
    overdueSince: null,
    openedAt: new Date('2026-10-05T12:00:00.000Z'),
    ...patch,
  };
}

/** Background: 42 abertos (3 atrasados e 5 a vencer), 2 encerrados/rascunho, 1 de outro tenant. */
function background(): DashboardProcessRow[] {
  const rows: DashboardProcessRow[] = [];
  for (let n = 1; n <= 34; n += 1) {
    rows.push(
      processRow(
        n,
        n > 30 ? { requestingSecretariatId: SAUDE, requestingDepartmentId: SAUDE_SETOR } : {},
      ),
    );
  }
  for (let n = 35; n <= 37; n += 1) {
    rows.push(processRow(n, { overdueSince: new Date('2026-10-15T12:00:00.000Z') }));
  }
  for (let n = 38; n <= 42; n += 1) {
    rows.push(processRow(n, { currentStageDueAt: new Date('2026-10-21T20:00:00.000Z') }));
  }
  rows.push(processRow(43, { status: 'DRAFT', openedAt: null }));
  rows.push(processRow(44, { status: 'COMPLETED' }));
  rows.push(processRow(99, { tenantId: B, overdueSince: NOW }));
  return rows;
}

/** O processo "0030/2026" da Saúde, sigiloso, R$ 500.000,00 (cenário de POL-09). */
const confidential = () =>
  processRow(45, {
    code: '0030/2026',
    requestingSecretariatId: SAUDE,
    requestingDepartmentId: SAUDE_SETOR,
    currentDepartmentId: SAUDE_SETOR,
    isBudgetConfidential: true,
    estimatedValue: '500000.00',
  });

function activity(n: number, patch: Partial<DashboardActivityRow> = {}): DashboardActivityRow {
  return {
    id: pid(5000 + n),
    tenantId: A,
    processId: pid(1),
    occurredAt: new Date(Date.UTC(2026, 9, 20, 10, n)),
    type: 'PROCESS_FORWARDED',
    actorType: 'USER',
    actorId: ANA,
    actorName: 'Ana Souza',
    actorDepartmentName: null,
    entityType: null,
    entityId: null,
    movementId: null,
    params: {},
    visibility: 'STANDARD',
    ...patch,
  };
}

function inboxRow(n: number, patch: Partial<InboxProcessRow> = {}): InboxProcessRow {
  return {
    tenantId: A,
    id: pid(n),
    organizationId: ORG,
    code: `${String(n).padStart(4, '0')}/2026`,
    number: n,
    year: 2026,
    title: `Processo ${String(n)}`,
    status: 'IN_PROGRESS',
    version: 1,
    isBudgetConfidential: false,
    requestingSecretariatId: OBRAS,
    requestingDepartmentId: MANUT,
    currentDepartmentId: MANUT,
    currentResponsibleId: GESTORA,
    currentWorkflowStageId: null,
    stageId: pid(1000 + n),
    enteredAt: NOW,
    dueAt: null,
    overdueSince: null,
    slaType: 'BUSINESS',
    pausedAt: null,
    assignmentDepartmentId: MANUT,
    assigneeId: GESTORA,
    assignmentType: 'STAGE_ENTRY',
    ...patch,
  };
}

class FlakyTransactions implements DashboardTransactions {
  failure: Error | null = null;

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }
}

class DownCacheStore implements CacheStore {
  get(): Promise<string | null> {
    return Promise.reject(new Error('ECONNREFUSED'));
  }

  set(): Promise<void> {
    return Promise.reject(new Error('ECONNREFUSED'));
  }

  delete(): Promise<void> {
    return Promise.reject(new Error('ECONNREFUSED'));
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

async function seedStructure(api: TestApi): Promise<void> {
  await runTenantSeeders(api, A, ['catalog.items', 'catalog.holidays', 'access.defaultRoles']);
  const obras = seedDepartment(api, {
    tenantId: A,
    id: OBRAS,
    organizationId: ORG,
    name: 'Secretaria de Obras',
  });
  seedDepartment(api, {
    tenantId: A,
    id: MANUT,
    organizationId: ORG,
    name: 'Setor de Manutenção',
    parent: obras,
  });
  const saude = seedDepartment(api, {
    tenantId: A,
    id: SAUDE,
    organizationId: ORG,
    name: 'Secretaria de Saúde',
  });
  seedDepartment(api, {
    tenantId: A,
    id: SAUDE_SETOR,
    organizationId: ORG,
    name: 'Setor de Vigilância',
    parent: saude,
  });
  seedDepartment(api, {
    tenantId: A,
    id: INATIVA,
    organizationId: ORG,
    name: 'Secretaria Extinta',
    isActive: false,
  });
  seedDepartment(api, { tenantId: B, id: SETOR_Y, organizationId: ORG, name: 'Setor Y' });
  seedMember(api, {
    id: GESTORA,
    membershipId: GESTORA_M,
    tenantId: A,
    subject: 'sub-gestora-us076',
  });
  seedMember(api, {
    id: BRUNO,
    membershipId: BRUNO_M,
    tenantId: A,
    subject: 'sub-bruno-us076',
  });
  // "Ana": gestão em escopo TENANT, sem a permissão de orçamento sigiloso.
  const manager = seedCustomRole(api, A, 'Gestão sem sigilo', [
    'DASHBOARD_VIEW',
    'PROCESS_VIEW',
    'INBOX_VIEW',
  ]);
  assignRole(api, { tenantId: A, membershipId: GESTORA_M, roleId: manager.id });
  // "Bruno": consulta processos, mas não tem o painel.
  const viewOnly = seedCustomRole(api, A, 'Somente consulta', ['PROCESS_VIEW']);
  assignRole(api, { tenantId: A, membershipId: BRUNO_M, roleId: viewOnly.id });
  // "Carla": REQUISITANTE lotada na Secretaria de Obras (PROCESS_VIEW das lotações).
  assignDepartment(api, membershipOf(ANA), OBRAS);
}

describe('Feature: Dashboard operacional por perfil (US-076)', () => {
  let api: TestApi;
  const reader = new InMemoryDashboardReader();
  const inbox = new InMemoryInboxReader();
  const transactions = new FlakyTransactions();

  const get = (path: string, subject = 'sub-gestora-us076', tenantId: string = A) =>
    request(api.server)
      .get(`/api/v1/dashboard${path}`)
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const summary = async (query = '', subject = 'sub-gestora-us076') => {
    const response = await get(`/summary${query}`, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return dashboardSummaryResponseSchema.parse(response.body);
  };
  const widget = async <K extends (typeof DASHBOARD_WIDGET_KEYS)[number]>(
    key: K,
    query = '',
    subject = 'sub-gestora-us076',
  ) => {
    const response = await get(`/widgets/${key}${query}`, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = dashboardWidgetResponseSchema.parse(response.body);
    expect(body.data.widgetKey).toBe(key);
    return { data: body.data as DashboardWidgetOf<K>, meta: body.meta };
  };

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: DASHBOARD_READER, value: reader },
        { token: DASHBOARD_TRANSACTIONS, value: transactions },
        { token: DASHBOARD_CLOCK, value: () => NOW },
        { token: INBOX_READER, value: inbox },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await seedStructure(api);
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    // Cada cenário começa sem o cache de 60 s do anterior (o mesmo usuário repete consultas).
    api.app.get<InMemoryCacheStore>(CACHE_STORE).entries.clear();
    reader.clear();
    inbox.clear();
    transactions.failure = null;
    reader.seed({ processes: background() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('[Sucesso]', () => {
    it('Carregar o resumo do painel: 42 abertos, 3 atrasados e 5 a vencer, só os visíveis', async () => {
      inbox.seed({
        processes: [inboxRow(1), inboxRow(2), inboxRow(3, { tenantId: B })],
      });
      const body = await summary();
      expect(body.data).toMatchObject({
        pendingCount: 2,
        overdueCount: 3,
        dueSoonCount: 5,
        openCount: 42,
        generatedAt: NOW.toISOString(),
      });
      expect(body.meta.cache).toEqual({
        hit: false,
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      });
    });

    it('Carregar o widget "por status": série de todos os ProcessStatus; soma = total visível', async () => {
      const { data } = await widget('BY_STATUS');
      expect(data.series.map((item) => item.key)).toEqual([
        'DRAFT',
        'IN_PROGRESS',
        'AWAITING_APPROVAL',
        'RETURNED',
        'SUSPENDED',
        'CANCELED',
        'COMPLETED',
        'PUBLISHED',
      ]);
      expect(data.series.find((item) => item.key === 'IN_PROGRESS')?.value).toBe(42);
      expect(data.total).toBe(44);
      expect(data.series.reduce((total, item) => total + item.value, 0)).toBe(44);
    });

    it('os 9 indicadores do registro respondem no contrato (RN-DASH-02)', async () => {
      reader.seed({
        stages: [
          {
            tenantId: A,
            processId: pid(1),
            workflowStageId: STAGE,
            enteredAt: new Date('2026-10-01T12:00:00.000Z'),
            exitedAt: new Date('2026-10-03T12:00:00.000Z'),
          },
        ],
        activity: [activity(1), activity(2, { processId: pid(99), tenantId: B })],
      });
      for (const key of DASHBOARD_WIDGET_KEYS) await widget(key);
      expect((await widget('BY_STAGE')).data).toMatchObject({
        total: 42,
        series: [{ key: STAGE, value: 42 }],
      });
      expect((await widget('OVERDUE')).data).toMatchObject({
        total: 3,
        series: [{ key: OBRAS, label: 'Secretaria de Obras', value: 3 }],
      });
      expect((await widget('DUE_SOON')).data).toMatchObject({
        total: 5,
        warnBeforeBusinessDays: 2,
      });
      expect((await widget('AVG_STAGE_DURATION')).data).toMatchObject({
        windowDays: 90,
        series: [{ key: STAGE, value: 2 * 86400, sampleSize: 1 }],
      });
      const opened = (await widget('OPENED_BY_MONTH')).data;
      expect(opened.series).toHaveLength(12);
      expect(opened.series.at(-1)).toEqual({ key: '2026-10', label: null, value: 43 });
      const recent = (await widget('RECENT_ACTIVITY')).data;
      expect(recent.items.map((item) => item.id)).toEqual([pid(5001)]);
      expect(recent.items[0]?.process).toEqual({ id: pid(1), code: '0001/2026' });
    });

    it('FA-01: tenant sem processos → zeros e listas vazias, sem bloquear', async () => {
      reader.clear();
      expect((await summary()).data).toMatchObject({
        pendingCount: 0,
        overdueCount: 0,
        dueSoonCount: 0,
        openCount: 0,
      });
      expect((await widget('VALUE_BY_SECRETARIAT')).data.series).toEqual([]);
      expect((await widget('RECENT_ACTIVITY')).data.items).toEqual([]);
      expect((await widget('BY_STATUS')).data.total).toBe(0);
    });

    it('filtro de secretaria/unidade recorta pela unidade solicitante (com subárvore)', async () => {
      expect((await summary(`?secretariatId=${SAUDE}`)).data.openCount).toBe(4);
      expect((await summary(`?secretariatId=${OBRAS}&departmentId=${MANUT}`)).data.openCount).toBe(
        38,
      );
      expect((await summary(`?departmentId=${OBRAS}`)).data.openCount).toBe(38);
    });

    it('RECENT_ACTIVITY: limit e ordem mais recente primeiro', async () => {
      reader.seed({ activity: [activity(1), activity(3), activity(2)] });
      const { data } = await widget('RECENT_ACTIVITY', '?limit=2');
      expect(data.items.map((item) => item.id)).toEqual([pid(5003), pid(5002)]);
    });

    it('log info dashboard.widget_served sem valores monetários nem títulos', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await widget('VALUE_BY_SECRETARIAT');
      const entry = log.mock.calls.find(([message]) => {
        const record = message as { event?: string };
        return record.event === 'dashboard.widget_served';
      })?.[0] as Record<string, unknown> | undefined;
      expect(entry).toMatchObject({
        widgetKey: 'VALUE_BY_SECRETARIAT',
        tenantId: A,
        userId: GESTORA,
        cacheHit: false,
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/10000|380000/);
    });
  });

  describe('[Validação]', () => {
    it('Indicador inexistente → 404 WIDGET_NOT_FOUND', async () => {
      const body = expectProblem(
        await get('/widgets/VALOR_TOTAL_FICTICIO'),
        404,
        'WIDGET_NOT_FOUND',
      );
      expect(body.detail).toBe('Indicador não encontrado.');
    });

    it('Unidade fora da secretaria filtrada → 422 DEPARTMENT_NOT_IN_SECRETARIAT em departmentId', async () => {
      const body = expectProblem(
        await get(`/summary?secretariatId=${OBRAS}&departmentId=${SAUDE_SETOR}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'departmentId', code: 'DEPARTMENT_NOT_IN_SECRETARIAT' }),
      ]);
      expectProblem(
        await get(`/widgets/BY_STATUS?secretariatId=${OBRAS}&departmentId=${SAUDE_SETOR}`),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('referência inativa, inexistente, não secretaria ou malformada → 422', async () => {
      const inactive = expectProblem(
        await get(`/summary?secretariatId=${INATIVA}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(inactive.errors[0]).toMatchObject({
        field: 'secretariatId',
        code: 'REFERENCE_INACTIVE',
        message: 'Selecione uma secretaria/unidade válida.',
      });
      const missing = expectProblem(
        await get(`/summary?departmentId=${pid(7777)}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors[0]).toMatchObject({
        field: 'departmentId',
        code: 'REFERENCE_NOT_FOUND',
      });
      const sector = expectProblem(
        await get(`/summary?secretariatId=${MANUT}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(sector.errors[0]).toMatchObject({ field: 'secretariatId', code: 'NOT_ALLOWED' });
      const malformed = expectProblem(
        await get('/summary?secretariatId=abc'),
        422,
        'VALIDATION_ERROR',
      );
      expect(malformed.errors[0]?.field).toBe('secretariatId');
    });

    it('V-04: limit de RECENT_ACTIVITY fora de 1–100 → 422 OUT_OF_RANGE', async () => {
      for (const limit of ['0', '101']) {
        const body = expectProblem(
          await get(`/widgets/RECENT_ACTIVITY?limit=${limit}`),
          422,
          'VALIDATION_ERROR',
        );
        expect(body.errors[0]).toMatchObject({
          field: 'limit',
          code: 'OUT_OF_RANGE',
          message: 'Informe um limite entre 1 e 100.',
        });
      }
      // Parâmetro desconhecido também é recusado (query estrita).
      expectProblem(await get('/summary?foo=1'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem DASHBOARD_VIEW → 403 PERMISSION_DENIED e access.denied DASHBOARD_VIEW', async () => {
      const body = expectProblem(
        await get('/summary', 'sub-bruno-us076'),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não tem permissão para acessar o painel.');
      expectProblem(await get('/widgets/BY_STATUS', 'sub-bruno-us076'), 403, 'PERMISSION_DENIED');
      const denied = api
        .auditRecords()
        .filter((record) => record.action === 'access.denied' && record.actorUserId === BRUNO);
      expect(denied.at(-1)).toMatchObject({ result: 'DENIED', reasonCode: 'DASHBOARD_VIEW' });
    });

    it('Valor por secretaria mascarado sem a permissão de orçamento sigiloso (POL-09)', async () => {
      reader.seed({ processes: [confidential()] });
      const { data } = await widget('VALUE_BY_SECRETARIAT');
      const saude = data.series.find((item) => item.key === SAUDE);
      // 4 processos de R$ 10.000,00 da Saúde; o sigiloso de R$ 500.000,00 fica fora da soma.
      expect(saude).toEqual({
        key: SAUDE,
        label: 'Secretaria de Saúde',
        value: '40000.00',
        confidentialExcluded: true,
      });
      expect(data.series.find((item) => item.key === OBRAS)).toMatchObject({
        value: '380000.00',
        confidentialExcluded: false,
      });
      // Com a permissão (Lúcia, GESTOR_CONTRATACOES), o total inclui o sigiloso.
      const full = await widget('VALUE_BY_SECRETARIAT', '', 'sub-lucia');
      expect(full.data.series.find((item) => item.key === SAUDE)).toMatchObject({
        value: '540000.00',
        confidentialExcluded: false,
      });
    });

    it('custodiante atual soma o sigiloso mesmo sem a permissão', async () => {
      reader.seed({ processes: [{ ...confidential(), currentResponsibleId: GESTORA }] });
      const { data } = await widget('VALUE_BY_SECRETARIAT');
      expect(data.series.find((item) => item.key === SAUDE)).toMatchObject({
        value: '540000.00',
        confidentialExcluded: false,
      });
    });

    it('RECENT_ACTIVITY omite BUDGET_RESTRICTED sem POL-09 (RN-DASH-08)', async () => {
      reader.seed({
        processes: [confidential()],
        activity: [
          activity(1, { processId: pid(45), visibility: 'BUDGET_RESTRICTED' }),
          activity(2, { processId: pid(45) }),
          // Orçamento tornado público não revela o passado: avaliado como sigiloso.
          activity(3, { processId: pid(1), visibility: 'BUDGET_RESTRICTED' }),
        ],
      });
      const restricted = await widget('RECENT_ACTIVITY');
      expect(restricted.data.items.map((item) => item.id)).toEqual([pid(5002)]);
      const allowed = await widget('RECENT_ACTIVITY', '', 'sub-lucia');
      expect(allowed.data.items.map((item) => item.id)).toEqual([pid(5003), pid(5002), pid(5001)]);
    });

    it('FA-03: filtro fora do escopo do usuário → resultado vazio, nunca erro', async () => {
      const body = await summary(`?secretariatId=${SAUDE}`, 'sub-ana');
      expect(body.data).toMatchObject({ overdueCount: 0, dueSoonCount: 0, openCount: 0 });
      expect((await widget('BY_STATUS', `?secretariatId=${SAUDE}`, 'sub-ana')).data.total).toBe(0);
    });

    it('sem autenticação → 401', async () => {
      const response = await request(api.server)
        .get('/api/v1/dashboard/summary')
        .set('X-Tenant-Id', A);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Filtro com unidade de outro tenant → 422 REFERENCE_NOT_FOUND sem revelar a unidade', async () => {
      const body = expectProblem(
        await get(`/summary?departmentId=${SETOR_Y}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        {
          field: 'departmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma secretaria/unidade válida.',
        },
      ]);
      // Mesma resposta de uma unidade que não existe em lugar nenhum.
      const missing = expectProblem(
        await get(`/summary?departmentId=${pid(7777)}`),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors).toEqual(body.errors);
    });

    it('processos de outro tenant nunca entram nos números; sem vínculo no tenant → 403', async () => {
      expect((await widget('OVERDUE')).data.total).toBe(3);
      expect((await get('/summary', 'sub-gestora-us076', B)).status).toBe(403);
    });
  });

  describe('[Duplicidade]', () => {
    it('Repetição dentro da janela de cache: mesmos dados, cache.hit e nenhuma nova agregação', async () => {
      const first = await widget('BY_STATUS');
      expect(first.meta.cache.hit).toBe(false);
      const callsAfterFirst = reader.calls;
      const second = await widget('BY_STATUS');
      expect(second.meta.cache).toEqual({ hit: true, expiresAt: first.meta.cache.expiresAt });
      expect(second.data).toEqual(first.data);
      expect(reader.calls).toBe(callsAfterFirst);
      // Outro recorte ou outro usuário não reaproveita a entrada.
      expect((await widget('BY_STATUS', `?secretariatId=${OBRAS}`)).meta.cache.hit).toBe(false);
      expect((await widget('BY_STATUS', '', 'sub-lucia')).meta.cache.hit).toBe(false);
    });
  });

  describe('[Concorrência]', () => {
    it('Usuários com escopos diferentes em requisições simultâneas não misturam dados', async () => {
      const [ana, carla] = await Promise.all([
        get('/summary?secretariatId=' + OBRAS, 'sub-lucia'),
        get('/summary', 'sub-ana'),
      ]);
      const [tenant, own] = await Promise.all([
        summary('', 'sub-gestora-us076'),
        summary('', 'sub-ana'),
      ]);
      expect(tenant.data.openCount).toBe(42);
      // "Carla" (lotada em Obras) vê só os processos da Secretaria de Obras.
      expect(own.data.openCount).toBe(38);
      expect(ana.status).toBe(200);
      expect(carla.status).toBe(200);
      expect(dashboardSummaryResponseSchema.parse(carla.body).data.openCount).toBe(38);
    });

    it('duas requisições concorrentes em cache miss geram o mesmo resultado', async () => {
      const [left, right] = await Promise.all([
        get('/widgets/OVERDUE', 'sub-lucia'),
        get('/widgets/OVERDUE', 'sub-lucia'),
      ]);
      expect(dashboardWidgetResponseSchema.parse(left.body).data).toEqual(
        dashboardWidgetResponseSchema.parse(right.body).data,
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After e error dashboard.widget_failed', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get('/widgets/AVG_STAGE_DURATION');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expectProblem(await get('/summary'), 503, 'DEPENDENCY_UNAVAILABLE');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'dashboard.widget_failed',
          widgetKey: 'AVG_STAGE_DURATION',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'dashboard.widget_failed',
      );
    });

    it('statement_timeout vira 503 (consulta acima do teto)', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = Object.assign(
        new Error('canceling statement due to statement timeout'),
        { code: 'P2010', meta: { code: '57014' } },
      );
      expectProblem(await get('/widgets/BY_STAGE'), 503, 'DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: 200 calculado no banco e warn dashboard.cache_unavailable', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const degradedReader = new InMemoryDashboardReader();
      const degraded = await createTestApi({
        providers: [
          { token: CACHE_STORE, value: new DownCacheStore() },
          { token: DASHBOARD_READER, value: degradedReader },
          { token: DASHBOARD_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await seedStructure(degraded);
        degradedReader.seed({ processes: background() });
        const auth = (call: request.Test) =>
          call
            .set('Authorization', degraded.bearer('sub-gestora-us076', { amr: ['pwd', 'otp'] }))
            .set('X-Tenant-Id', A);
        const response = await auth(request(degraded.server).get('/api/v1/dashboard/summary'));
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const body = dashboardSummaryResponseSchema.parse(response.body);
        expect(body.data.openCount).toBe(42);
        expect(body.meta.cache.hit).toBe(false);
        // Sem cache, a repetição agrega de novo (nunca um acerto falso).
        const again = await auth(request(degraded.server).get('/api/v1/dashboard/summary'));
        expect(dashboardSummaryResponseSchema.parse(again.body).meta.cache.hit).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'dashboard.cache_unavailable', widgetKey: 'SUMMARY' }),
          'dashboard.cache_unavailable',
        );
      } finally {
        await degraded.close();
      }
    });
  });

  describe('RN-DASH-03 — PENDING_ITEMS = contadores de TSK-02', () => {
    it('as séries e o pendingCount conferem com /tasks/counters', async () => {
      inbox.seed({
        processes: [
          inboxRow(1),
          inboxRow(2, { assignmentType: 'RETURN' }),
          inboxRow(3, { assigneeId: null, currentResponsibleId: null }),
        ],
      });
      const counters = await request(api.server)
        .get('/api/v1/tasks/counters')
        .set('Authorization', api.bearer('sub-gestora-us076', { amr: ['pwd', 'otp'] }))
        .set('X-Tenant-Id', A);
      const tasks = taskInboxCountersResponseSchema.parse(counters.body).data;
      const { data } = await widget('PENDING_ITEMS');
      const value = (key: string) => data.series.find((item) => item.key === key)?.value;
      expect(value('MINE')).toBe(tasks.mine);
      expect(value('RETURNED')).toBe(tasks.returned);
      expect(value('PENDING_APPROVALS')).toBe(tasks.pendingApprovals);
      expect(value('FOLLOWING')).toBe(tasks.following);
      expect(data.total).toBe(tasks.mine + tasks.pendingApprovals);
      expect((await summary()).data.pendingCount).toBe(data.total);
      // Recorte: processos de outra secretaria não entram.
      const filtered = await widget('PENDING_ITEMS', `?secretariatId=${SAUDE}`);
      expect(filtered.data.total).toBe(0);
    });
  });
});
