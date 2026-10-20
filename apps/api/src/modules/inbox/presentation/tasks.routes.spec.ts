import { randomUUID } from 'node:crypto';

import {
  problemDetailsSchema,
  taskInboxCountersResponseSchema,
  taskInboxResponseSchema,
} from '@contrataflow/validation';
import type { TaskInboxResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { CATALOG_CLOCK, runTenantSeeders } from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedCustomRole,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { INBOX_CLOCK, INBOX_READER, INBOX_TRANSACTIONS } from '../application/ports.js';
import type { InboxTransactions } from '../application/ports.js';
import type { InboxApprovalRow, InboxProcessRow } from '../domain/task-inbox.js';
import { InMemoryInboxReader } from '../infrastructure/task-inbox.readers.js';

/*
 * US-056 — TSK-01/TSK-02 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização
 * `INBOX_VIEW`, validação Zod, filtro RFC 9457) com a identidade fake e o leitor em memória das
 * views publicadas (os predicados puros do domínio). Personas: Ana (REQUISITANTE, lotada e
 * titular do Setor de Manutenção); "Bruno" = Fábio com um perfil só de caixa (sem PROCESS_CLAIM,
 * sem titularidade); Lúcia com um perfil só de consulta de processos (sem INBOX_VIEW). O SQL, a RLS das views, o "Assumir" de
 * ponta a ponta, a concorrência e o reenvio idempotente estão em `test/tenant-leak/task-inbox.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-19T15:00:00.000Z');
const ORG = '0192e056-0000-7000-8000-0000000000a0';
const MANUT = '0192e056-0000-7000-8000-0000000000a2';
const COMPRAS = '0192e056-0000-7000-8000-0000000000a3';
const ANA = FAKE_USERS.ana.id;
const FABIO = FAKE_USERS.fabio.id;
const LUCIA = FAKE_USERS.lucia.id;

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';
const pid = (n: number) => `0192e056-0000-7000-8000-${String(n).padStart(12, '0')}`;

function processRow(n: number, patch: Partial<InboxProcessRow> = {}): InboxProcessRow {
  return {
    tenantId: A,
    id: pid(n),
    organizationId: ORG,
    code: `${String(n).padStart(4, '0')}/2026`,
    number: n,
    year: 2026,
    title: `Processo sigiloso de teste ${String(n)}`,
    status: 'IN_PROGRESS',
    version: 2,
    isBudgetConfidential: false,
    requestingSecretariatId: MANUT,
    requestingDepartmentId: MANUT,
    currentDepartmentId: MANUT,
    currentResponsibleId: null,
    currentWorkflowStageId: null,
    stageId: pid(1000 + n),
    enteredAt: new Date(`2026-10-0${String((n % 9) + 1)}T12:00:00.000Z`),
    dueAt: null,
    overdueSince: null,
    slaType: 'BUSINESS',
    pausedAt: null,
    assignmentDepartmentId: MANUT,
    assigneeId: null,
    assignmentType: 'STAGE_ENTRY',
    ...patch,
  };
}

const mine = (n: number, patch: Partial<InboxProcessRow> = {}) =>
  processRow(n, { assigneeId: ANA, currentResponsibleId: ANA, ...patch });

function approvalRow(n: number, patch: Partial<InboxApprovalRow> = {}): InboxApprovalRow {
  return {
    tenantId: A,
    id: pid(2000 + n),
    processId: pid(n),
    subjectType: 'PROCESS_STAGE',
    title: 'Aprovação do DFD',
    requestedById: LUCIA,
    requestedAt: new Date('2026-10-12T12:00:00.000Z'),
    dueAt: new Date('2026-10-24T02:59:59.999Z'),
    approverType: 'USER',
    approverUserId: ANA,
    approverRoleId: null,
    approverDepartmentId: null,
    allowDeputy: false,
    ...patch,
  };
}

class FlakyTransactions implements InboxTransactions {
  failure: Error | null = null;

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Caixa de tarefas unificada (US-056)', () => {
  let api: TestApi;
  const reader = new InMemoryInboxReader();
  const transactions = new FlakyTransactions();

  const get = (path: string, subject = 'sub-ana', tenantId: string = A) =>
    request(api.server)
      .get(`/api/v1/tasks${path}`)
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const list = async (query: string, subject = 'sub-ana'): Promise<TaskInboxResponse> => {
    const response = await get(query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return taskInboxResponseSchema.parse(response.body);
  };
  const counters = async (subject = 'sub-ana') => {
    const response = await get('/counters', subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return taskInboxCountersResponseSchema.parse(response.body).data;
  };
  const codes = (body: TaskInboxResponse) => body.data.map((item) => item.code);

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: INBOX_READER, value: reader },
        { token: INBOX_TRANSACTIONS, value: transactions },
        { token: INBOX_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, ['catalog.items', 'access.defaultRoles']);
    seedDepartment(api, {
      tenantId: A,
      id: MANUT,
      organizationId: ORG,
      name: 'Setor de Manutenção',
      headUserId: ANA,
    });
    seedDepartment(api, {
      tenantId: A,
      id: COMPRAS,
      organizationId: ORG,
      name: 'Departamento de Compras',
    });
    assignDepartment(api, membershipOf(ANA), MANUT);
    assignDepartment(api, membershipOf(FABIO), MANUT);
    // "Bruno": só a caixa e a visão de processos — sem PROCESS_CLAIM e sem titularidade.
    const inboxOnly = seedCustomRole(api, A, 'Somente caixa', ['INBOX_VIEW', 'PROCESS_VIEW']);
    assignRole(api, { tenantId: A, membershipId: membershipOf(FABIO), roleId: inboxOnly.id });
    // Lúcia: consulta processos, mas não tem a caixa de tarefas (caso excepcional — 403).
    const viewOnly = seedCustomRole(api, A, 'Somente consulta', ['PROCESS_VIEW']);
    assignRole(api, { tenantId: A, membershipId: membershipOf(LUCIA), roleId: viewOnly.id });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    reader.clear();
    transactions.failure = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('[Sucesso]', () => {
    it('Ver os processos sob minha responsabilidade: exatamente os 3 e o contador 3', async () => {
      reader.seed({
        processes: [mine(1), mine(2), mine(3), processRow(4, { assigneeId: LUCIA })],
      });
      const body = await list('?view=MINE');
      expect(codes(body).sort()).toEqual(['0001/2026', '0002/2026', '0003/2026']);
      expect(body.meta).toEqual({ page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });
      expect((await counters()).mine).toBe(3);
      // Sem `view`, o padrão é MINE (RN-INBOX-02).
      expect((await list('')).meta.totalItems).toBe(3);
    });

    it('linha com unidade, responsável, prazo e deadline; nenhuma ação no clique (somente leitura)', async () => {
      reader.seed({
        processes: [
          mine(1, {
            dueAt: new Date('2026-10-30T02:59:59.999Z'),
            overdueSince: null,
            isBudgetConfidential: true,
          }),
        ],
      });
      const [item] = (await list('?view=MINE')).data;
      expect(item).toMatchObject({
        id: pid(1),
        processId: pid(1),
        code: '0001/2026',
        status: 'IN_PROGRESS',
        version: 2,
        currentDepartment: { id: MANUT, name: 'Setor de Manutenção' },
        currentResponsible: { id: ANA, name: FAKE_USERS.ana.name },
        dueAt: '2026-10-30T02:59:59.999Z',
        isOverdue: false,
        isBudgetConfidential: true,
        canClaim: false,
      });
      expect(item?.deadline).toMatchObject({ dueAt: '2026-10-30T02:59:59.999Z', isOverdue: false });
      // FA-05: nenhum valor monetário na linha.
      expect(JSON.stringify(item)).not.toMatch(/estimatedValue/);
    });

    it('fila da unidade (titular lotado com PROCESS_CLAIM): "Assumir" só nas linhas sem responsável', async () => {
      reader.seed({
        processes: [processRow(12), processRow(13, { status: 'SUSPENDED' }), mine(14)],
      });
      const body = await list('?view=UNIT_QUEUE');
      expect(body.data.map((item) => [item.code, item.canClaim])).toEqual([
        ['0013/2026', false],
        ['0012/2026', true],
      ]);
      expect((await counters()).unitQueue).toBe(2);
    });

    it('aprovações pendentes, devolvidos, atrasados e acompanhando — contadores = totais (RN-INBOX-09)', async () => {
      const late = new Date('2026-10-16T03:00:00.000Z');
      reader.seed({
        processes: [
          mine(1, { overdueSince: late }),
          processRow(2, { assignmentType: 'RETURN' }),
          mine(3, { assignmentType: 'RETURN' }),
          processRow(4, { assigneeId: LUCIA }),
          processRow(5, { assigneeId: LUCIA, overdueSince: late }),
        ],
        approvals: [approvalRow(4), approvalRow(5, { approverUserId: LUCIA })],
        participations: [{ tenantId: A, processId: pid(5), userId: ANA, expiresAt: null }],
      });
      const approvals = await list('?view=PENDING_APPROVALS');
      expect(approvals.data).toHaveLength(1);
      expect(approvals.data[0]).toMatchObject({
        id: pid(2004),
        processId: pid(4),
        dueAt: '2026-10-24T02:59:59.999Z',
        approval: {
          id: pid(2004),
          title: 'Aprovação do DFD',
          subjectType: 'PROCESS_STAGE',
          requestedBy: { id: LUCIA, name: FAKE_USERS.lucia.name },
          requestedAt: '2026-10-12T12:00:00.000Z',
        },
      });
      expect(codes(await list('?view=RETURNED')).sort()).toEqual(['0002/2026', '0003/2026']);
      const overdue = await list('?view=OVERDUE');
      expect(codes(overdue)).toEqual(['0001/2026']);
      expect(overdue.data[0]?.isOverdue).toBe(true);
      expect(codes(await list('?view=FOLLOWING'))).toEqual(['0005/2026']);
      const all = await counters();
      for (const [view, key] of [
        ['MINE', 'mine'],
        ['UNIT_QUEUE', 'unitQueue'],
        ['PENDING_APPROVALS', 'pendingApprovals'],
        ['RETURNED', 'returned'],
        ['OVERDUE', 'overdue'],
        ['FOLLOWING', 'following'],
      ] as const) {
        expect(all[key], view).toBe((await list(`?view=${view}`)).meta.totalItems);
      }
    });

    it('ordena por prazo (padrão -dueAt, nulos por último), código e entrada; pagina', async () => {
      reader.seed({
        processes: [
          mine(1, { dueAt: new Date('2026-10-20T02:59:59.999Z') }),
          mine(2),
          mine(3, { dueAt: new Date('2026-10-28T02:59:59.999Z') }),
        ],
      });
      expect(codes(await list('?view=MINE'))).toEqual(['0003/2026', '0001/2026', '0002/2026']);
      expect(codes(await list('?view=MINE&sort=dueAt'))).toEqual([
        '0001/2026',
        '0003/2026',
        '0002/2026',
      ]);
      expect(codes(await list('?view=MINE&sort=-code'))).toEqual([
        '0003/2026',
        '0002/2026',
        '0001/2026',
      ]);
      expect(codes(await list('?view=MINE&sort=enteredAt'))).toEqual([
        '0001/2026',
        '0002/2026',
        '0003/2026',
      ]);
      const page2 = await list('?view=MINE&sort=code&page=2&pageSize=2');
      expect(codes(page2)).toEqual(['0003/2026']);
      expect(page2.meta).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
    });

    it('FA-02: visão vazia responde data [] (a UI mostra o estado vazio)', async () => {
      const body = await list('?view=PENDING_APPROVALS');
      expect(body.data).toEqual([]);
      expect(body.meta.totalItems).toBe(0);
    });

    it('registra info inbox.query sem título do processo', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      reader.seed({ processes: [mine(1)] });
      await list('?view=MINE');
      const entry = log.mock.calls.find(([message]) => {
        const record = message as { event?: string };
        return record.event === 'inbox.query';
      })?.[0] as Record<string, unknown> | undefined;
      expect(entry).toMatchObject({ view: 'MINE', resultCount: 1, tenantId: A, userId: ANA });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Processo sigiloso de teste/);
    });
  });

  describe('[Validação]', () => {
    it('sort com campo não permitido para a visão → 422 INVALID_ENUM em sort', async () => {
      const body = expectProblem(
        await get('?view=MINE&sort=invalidField'),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'sort', code: 'INVALID_ENUM' }),
      ]);
      const requested = expectProblem(
        await get('?view=MINE&sort=requestedAt'),
        422,
        'VALIDATION_ERROR',
      );
      expect(requested.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID_ENUM' });
    });

    it('view fora do enum e pageSize acima de 100 → 422', async () => {
      const view = expectProblem(await get('?view=ALL'), 422, 'VALIDATION_ERROR');
      expect(view.errors[0]).toMatchObject({ field: 'view', code: 'INVALID_ENUM' });
      const size = expectProblem(await get('?pageSize=101'), 422, 'VALIDATION_ERROR');
      expect(size.errors[0]).toMatchObject({ field: 'pageSize', code: 'OUT_OF_RANGE' });
    });
  });

  describe('[Permissão]', () => {
    it('sem PROCESS_CLAIM e sem titularidade: sem unitQueue nos contadores e a fila vazia', async () => {
      reader.seed({ processes: [processRow(12), processRow(13)] });
      const result = await counters('sub-fabio');
      expect(result).not.toHaveProperty('unitQueue');
      expect((await list('?view=UNIT_QUEUE', 'sub-fabio')).data).toEqual([]);
      // Para Ana (titular lotada com PROCESS_CLAIM) a fila existe.
      expect((await counters()).unitQueue).toBe(2);
    });

    it('sem INBOX_VIEW → 403 PERMISSION_DENIED nas duas rotas', async () => {
      const body = expectProblem(await get('?view=MINE', 'sub-lucia'), 403, 'PERMISSION_DENIED');
      expect(body.detail).toBe('Você não tem acesso à caixa de tarefas.');
      expectProblem(await get('/counters', 'sub-lucia'), 403, 'PERMISSION_DENIED');
    });

    it('sem autenticação → 401', async () => {
      const response = await request(api.server).get('/api/v1/tasks').set('X-Tenant-Id', A);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('processo de outro tenant atribuído ao mesmo usuário nunca aparece', async () => {
      reader.seed({
        processes: [mine(1), { ...mine(99), tenantId: B }],
        approvals: [{ ...approvalRow(99), tenantId: B }],
        participations: [{ tenantId: B, processId: pid(99), userId: ANA, expiresAt: null }],
      });
      for (const view of ['MINE', 'PENDING_APPROVALS', 'FOLLOWING']) {
        const body = await list(`?view=${view}`);
        expect(body.data.map((item) => item.processId)).not.toContain(pid(99));
      }
      expect(await counters()).toMatchObject({ mine: 1, pendingApprovals: 0, following: 0 });
      // Sem vínculo no tenant B, a consulta nem chega à caixa.
      expect((await get('?view=MINE', 'sub-ana', B)).status).toBe(403);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After e error inbox.query_failed', async () => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get('?view=MINE');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expectProblem(await get('/counters'), 503, 'DEPENDENCY_UNAVAILABLE');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'inbox.query_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'inbox.query_failed',
      );
    });

    it('statement_timeout vira 503 (consulta acima do teto)', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      transactions.failure = Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: 'P2010',
          meta: { code: '57014' },
        },
      );
      expectProblem(await get('?view=MINE'), 503, 'DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: TSK-01/TSK-02 seguem e o "Assumir" registra warn idempotency.store_unavailable', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const degradedReader = new InMemoryInboxReader();
      const degraded = await createTestApi({
        stores: 'redis',
        providers: [
          { token: INBOX_READER, value: degradedReader },
          { token: INBOX_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await runTenantSeeders(degraded, A, ['catalog.items', 'access.defaultRoles']);
        degradedReader.seed({ processes: [mine(1), mine(2)] });
        const auth = (call: request.Test) =>
          call
            .set('Authorization', degraded.bearer('sub-ana', { amr: ['pwd', 'otp'] }))
            .set('X-Tenant-Id', A);
        const listed = await auth(request(degraded.server).get('/api/v1/tasks?view=MINE'));
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(taskInboxResponseSchema.parse(listed.body).meta.totalItems).toBe(2);
        const counted = await auth(request(degraded.server).get('/api/v1/tasks/counters'));
        expect(counted.status, JSON.stringify(counted.body)).toBe(200);
        expect(taskInboxCountersResponseSchema.parse(counted.body).data.mine).toBe(2);
        // "Assumir" com chave: sem Redis, segue sem idempotência (o processo inexiste aqui → 404).
        const claimed = await auth(
          request(degraded.server).post(`/api/v1/processes/${pid(1)}/claim`),
        )
          .set('If-Match', '"2"')
          .set('Idempotency-Key', randomUUID())
          .send();
        expect(claimed.status, JSON.stringify(claimed.body)).toBe(404);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
      } finally {
        await degraded.close();
      }
    });
  });
});
