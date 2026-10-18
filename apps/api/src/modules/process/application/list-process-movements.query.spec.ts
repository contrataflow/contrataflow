import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { runWithRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';
import { encodeCursor } from '#shared/http/pagination.js';

import { ListProcessMovementsHandler } from './list-process-movements.query.js';
import type { ProcessRepository, ProcessTransactions } from './ports.js';
import type { AccessFacade } from '../../access/application/access.facade.js';
import type { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { OrganizationFacade } from '../../organization/application/organization.facade.js';
import type { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import { matchesMovementSearch, compareMovements } from '../domain/process-movements.js';
import type { MovementFeedSearch, StoredMovement } from '../domain/process-movements.js';

/*
 * US-054 — `ListProcessMovementsHandler` isolado: hidratação em lote (uma leitura por tipo para uma
 * página de 50 — sem N+1), cursor por `sequence`, `ip` com falha fechada, logs sem comentário nem
 * IP e o mapeamento de falhas (503/500). O pipeline HTTP fica em `process-movements.routes.spec.ts`.
 */

const id = (suffix: string) => `0192f054-0000-7000-8000-${suffix.padStart(12, '0')}`;
const PROCESS = id('p1');
const STAGE = id('s1');
const SECRET_COMMENT = 'Comentário confidencial da tramitação';
const SECRET_IP = '200.10.20.30';

function movement(sequence: number): StoredMovement {
  // Cada tramitação com unidades, usuários e aprovação próprios: o pior caso para N+1.
  return {
    id: id(`m${String(sequence)}`),
    tenantId: id('t1'),
    processId: PROCESS,
    sequence,
    action: sequence === 1 ? 'CREATE' : 'FORWARD',
    workflowTransitionId: null,
    fromProcessStageId: null,
    toProcessStageId: id(`ps${String(sequence)}`),
    fromWorkflowStageId: null,
    toWorkflowStageId: STAGE,
    fromDepartmentId: id(`df${String(sequence)}`),
    toDepartmentId: id(`dt${String(sequence)}`),
    fromUserId: id(`uf${String(sequence)}`),
    toUserId: id(`ut${String(sequence)}`),
    statusFrom: null,
    statusTo: 'IN_PROGRESS',
    actorType: 'USER',
    actorId: id(`ua${String(sequence)}`),
    actorDepartmentId: null,
    comment: SECRET_COMMENT,
    dueAt: null,
    documents: [],
    approvalId: id(`ap${String(sequence)}`),
    ip: SECRET_IP,
    userAgent: null,
    correlationId: `corr-${String(sequence)}`,
    metadata: {},
    occurredAt: new Date(Date.UTC(2026, 9, 1, 0, sequence)),
  };
}

function setup(
  options: { readonly movements?: number; readonly revealsIp?: () => Promise<boolean> } = {},
) {
  const rows = Array.from({ length: options.movements ?? 120 }, (_, index) => movement(index + 1));
  const searches: MovementFeedSearch[] = [];
  const calls = { stages: 0, departments: 0, names: 0, members: 0, approvals: 0 };
  let failure: Error | null = null;
  const processes = {
    listMovements: (_tx: TenantTx, search: MovementFeedSearch) => {
      searches.push(search);
      return Promise.resolve(
        rows
          .filter((row) => matchesMovementSearch(row, search))
          .sort(compareMovements)
          .slice(0, search.take),
      );
    },
  } as unknown as ProcessRepository;
  const transactions = {
    read: <T>(work: (tx: TenantTx) => Promise<T>) =>
      failure ? Promise.reject(failure) : runSimulatedTransaction(work),
  } as unknown as ProcessTransactions;
  const access = {
    revealsField: vi.fn(options.revealsIp ?? (() => Promise.resolve(false))),
  } as unknown as AccessFacade;
  const workflow = {
    releasedStages: () => {
      calls.stages += 1;
      return Promise.resolve([{ id: STAGE, name: 'Pesquisa de preços' }]);
    },
  } as unknown as WorkflowFacade;
  const organization = {
    departmentReferences: (_tx: TenantTx, ids: readonly string[]) => {
      calls.departments += 1;
      return Promise.resolve(
        new Map(ids.map((unit) => [unit, { name: `Unidade ${unit.slice(-4)}`, isActive: true }])),
      );
    },
  } as unknown as OrganizationFacade;
  const identity = {
    userDisplayNames: (_tx: TenantTx, ids: readonly string[]) => {
      calls.names += 1;
      return Promise.resolve(new Map(ids.map((user) => [user, `Pessoa ${user.slice(-4)}`])));
    },
    membersInTenant: (_tx: TenantTx, ids: readonly string[]) => {
      calls.members += 1;
      return Promise.resolve(ids.map((userId) => ({ userId, status: 'ACTIVE' })));
    },
  } as unknown as IdentityFacade;
  const approvals = {
    approvalSummaries: (_tx: TenantTx, ids: readonly string[]) => {
      calls.approvals += 1;
      return Promise.resolve(
        new Map(
          ids.map((approval) => [
            approval,
            { title: 'Aprovação', status: 'PENDING', decision: null },
          ]),
        ),
      );
    },
  } as unknown as ApprovalFacade;
  const handler = new ListProcessMovementsHandler(
    processes,
    transactions,
    access,
    workflow,
    organization,
    identity,
    approvals,
  );
  return {
    handler,
    searches,
    calls,
    fail: (error: Error) => {
      failure = error;
    },
  };
}

const inRequest = <T>(fn: () => Promise<T>) =>
  runWithRequestContext({ correlationId: 'corr-req', ip: '', userAgent: '' }, fn);

describe('ListProcessMovementsHandler (US-054)', () => {
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('página de 50 de 120 tramitações: uma leitura por tipo de referência (sem N+1)', async () => {
    const { handler, calls, searches } = setup();
    const page = await inRequest(() => handler.execute(PROCESS, { limit: 50 }));
    expect(page.data).toHaveLength(50);
    expect(page.data.map((item) => item.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => 120 - index),
    );
    expect(calls).toEqual({ stages: 1, departments: 1, names: 1, members: 1, approvals: 1 });
    expect(searches[0]).toMatchObject({ processId: PROCESS, beforeSequence: null, take: 51 });
    expect(page.meta).toEqual({
      nextCursor: encodeCursor({ s: 71 }),
      hasMore: true,
      canViewIp: false,
    });
    expect(page.data[0]?.toStage).toEqual({ id: STAGE, name: 'Pesquisa de preços' });
    expect(page.data[0]?.approvalSummary).toEqual({
      title: 'Aprovação',
      status: 'PENDING',
      decision: null,
    });
  });

  it('o cursor continua a partir da sequence seguinte; a última página fecha a lista', async () => {
    const { handler, searches } = setup();
    const last = await inRequest(() =>
      handler.execute(PROCESS, { limit: 50, cursor: encodeCursor({ s: 21 }) }),
    );
    expect(searches[0]?.beforeSequence).toBe(21);
    expect(last.data.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => 20 - index),
    );
    expect(last.meta).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it('V-04: cursor inválido → 422 INVALID_FORMAT antes de tocar o banco', async () => {
    const { handler, searches } = setup();
    for (const cursor of ['nao-e-cursor', encodeCursor({ s: 0 }), encodeCursor({ o: 'x' })]) {
      await expect(
        inRequest(() => handler.execute(PROCESS, { limit: 50, cursor })),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        errors: [
          {
            field: 'cursor',
            code: 'INVALID_FORMAT',
            message: 'Não foi possível continuar a lista. Recarregue.',
          },
        ],
      });
    }
    expect(searches).toEqual([]);
  });

  it('processo sem tramitações: lista vazia, sem leituras de hidratação', async () => {
    const { handler, calls } = setup({ movements: 0 });
    const page = await inRequest(() => handler.execute(PROCESS, { limit: 50 }));
    expect(page.data).toEqual([]);
    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, canViewIp: false });
    expect(calls).toEqual({ stages: 0, departments: 0, names: 0, members: 0, approvals: 0 });
  });

  it('com AUDIT_VIEW o ip vem; sem ele, null — e meta.canViewIp acompanha', async () => {
    const auditor = setup({ movements: 2, revealsIp: () => Promise.resolve(true) });
    const visible = await inRequest(() => auditor.handler.execute(PROCESS, { limit: 50 }));
    expect(visible.data.map((item) => item.ip)).toEqual([SECRET_IP, SECRET_IP]);
    expect(visible.meta.canViewIp).toBe(true);

    const common = setup({ movements: 2 });
    const hidden = await inRequest(() => common.handler.execute(PROCESS, { limit: 50 }));
    expect(hidden.data.map((item) => item.ip)).toEqual([null, null]);
    expect(hidden.meta.canViewIp).toBe(false);
  });

  it('[Falha de integração] decisão do AUDIT_VIEW indisponível: lista normal e ip tratado como não autorizado', async () => {
    const { handler } = setup({
      movements: 3,
      revealsIp: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const page = await inRequest(() => handler.execute(PROCESS, { limit: 50 }));
    expect(page.data).toHaveLength(3);
    expect(page.data.every((item) => item.ip === null)).toBe(true);
    expect(page.meta.canViewIp).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'process.movements_ip_check_failed' }),
      'process.movements_ip_check_failed',
    );
  });

  it('logs: info process.movements_listed com contagem e duração, sem comentário nem IP', async () => {
    const { handler } = setup({ movements: 5, revealsIp: () => Promise.resolve(true) });
    await inRequest(() => handler.execute(PROCESS, { limit: 50, action: ['FORWARD'] }));
    const listed = log.mock.calls.find((args) => args[1] === 'process.movements_listed');
    expect(listed?.[0]).toMatchObject({
      event: 'process.movements_listed',
      processId: PROCESS,
      itemCount: 4,
      filterKeys: ['action'],
      correlationId: 'corr-req',
    });
    expect(listed?.[0]).toHaveProperty('durationMs');
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(SECRET_COMMENT);
    expect(logged).not.toContain(SECRET_IP);
  });

  it('referência sem nome: id com nome null e warn process.movements_hydration_partial', async () => {
    const { handler } = setup({ movements: 1 });
    // A etapa `STAGE` existe; a de destino da tramitação nº 1 é trocada por uma ausente.
    const handlerWithMissing = handler as unknown as {
      workflow: { releasedStages: () => Promise<unknown[]> };
    };
    handlerWithMissing.workflow.releasedStages = () => Promise.resolve([]);
    const page = await inRequest(() => handler.execute(PROCESS, { limit: 50 }));
    expect(page.data[0]?.toStage).toEqual({ id: STAGE, name: null });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'process.movements_hydration_partial',
        processId: PROCESS,
        missingStages: 1,
        missingDepartments: 0,
        missingUsers: 0,
      }),
      'process.movements_hydration_partial',
    );
  });

  it('[Falha de banco] banco fora → 503 DEPENDENCY_UNAVAILABLE e error process.movements_list_failed', async () => {
    const { handler, fail } = setup();
    fail(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    await expect(inRequest(() => handler.execute(PROCESS, { limit: 50 }))).rejects.toBeInstanceOf(
      DatabaseUnavailableError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'process.movements_list_failed',
        errorCode: 'DEPENDENCY_UNAVAILABLE',
        correlationId: 'corr-req',
      }),
      'process.movements_list_failed',
    );
  });

  it('erro inesperado → repassado (500) com errorCode INTERNAL_ERROR; erro 4xx passa sem log', async () => {
    const bug = setup();
    bug.fail(new TypeError('bug'));
    await expect(
      inRequest(() => bug.handler.execute(PROCESS, { limit: 50 })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
      'process.movements_list_failed',
    );
    error.mockClear();
    const denied = setup();
    denied.fail(new ApiError('PROCESS_NOT_FOUND'));
    await expect(
      inRequest(() => denied.handler.execute(PROCESS, { limit: 50 })),
    ).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' });
    expect(error).not.toHaveBeenCalled();
  });
});
