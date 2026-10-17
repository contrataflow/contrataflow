import { withSpan } from '@contrataflow/observability';
import type {
  ProcessListItemDto,
  ProcessListMeta,
  ProcessListQuery,
  ProcessStageOptionDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isStatementTimeout } from '#shared/database/errors.js';
import { ApiError } from '#shared/errors/api-error.js';

import { PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessRepository, ProcessTransactions } from './ports.js';
import { ProcessListPresenter } from './process-list.presenter.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import type { ReleasedStage } from '../../workflow/application/workflow.facade.js';
import { effectiveOrder } from '../domain/process-list.js';
import type { ProcessListCriteria } from '../domain/process-list.js';

/*
 * `ListProcessesHandler` (US-002 · PRC-01): lista paginada, filtrada e ordenada dos processos que
 * o usuário vê. Autoriza (`PROCESS_VIEW` em algum escopo OU concessão `USER` — DEC-024 cond. 4),
 * resolve os valores reservados e as chaves de etapa, consulta página + total num snapshot e
 * apresenta (`ProcessListPresenter`: nomes por lote, mascaramento POL-09 por linha e o DTO
 * `deadline`). Somente leitura; nenhum evento. Logs sem o texto da busca nem valores.
 */

/** US-002 · "Impacto técnico": `SET LOCAL statement_timeout = '3s'`. */
export const PROCESS_LIST_STATEMENT_TIMEOUT_MS = 3000;
/** Acima disto: `warn process.list_slow` (meta p95 < 800 ms). */
export const PROCESS_LIST_SLOW_MS = 800;

export interface ProcessListResult {
  readonly items: ProcessListItemDto[];
  readonly meta: ProcessListMeta;
}

/** Chaves dos filtros usados (sem valores) — logs e métricas por combinação de filtros. */
export function filterKeysOf(query: ProcessListQuery): string[] {
  const technical = new Set(['page', 'pageSize', 'sort', 'includeStageOptions']);
  return Object.entries(query)
    .filter(([key, value]) => !technical.has(key) && value !== undefined)
    .map(([key]) => key)
    .sort();
}

/** Filtros de PRC-01 (a exportação — PRC-34 — usa os mesmos, sem paginação). */
export type ProcessListFilterQuery = Omit<
  ProcessListQuery,
  'page' | 'pageSize' | 'includeStageOptions'
>;

/** Valores reservados e chaves de etapa → critérios resolvidos (RN-PROC-21/22). */
export function resolveCriteria(
  query: ProcessListFilterQuery,
  context: {
    readonly userId: string;
    readonly ownDepartmentIds: readonly string[];
    readonly stages: readonly ReleasedStage[];
  },
): ProcessListCriteria {
  const ids = (values: readonly string[] | undefined, reserved: readonly string[] = []) =>
    values === undefined ? null : values.filter((value) => !reserved.includes(value));
  const responsible = query.currentResponsibleId;
  const department = query.currentDepartmentId;
  return {
    search: query.q ?? null,
    statuses: query.status ?? null,
    stageIdsByKey:
      query.stageKey === undefined
        ? null
        : context.stages
            .filter((stage) => query.stageKey?.includes(stage.key))
            .map((stage) => stage.id),
    currentWorkflowStageIds: query.currentWorkflowStageId ?? null,
    currentDepartmentIds:
      department === undefined
        ? null
        : [
            ...new Set([
              ...(ids(department, ['mine']) ?? []),
              ...(department.includes('mine') ? context.ownDepartmentIds : []),
            ]),
          ],
    requestingSecretariatIds: query.requestingSecretariatId ?? null,
    requestingDepartmentIds: query.requestingDepartmentId ?? null,
    organizationIds: query.organizationId ?? null,
    responsible:
      responsible === undefined
        ? null
        : {
            ids: [
              ...new Set([
                ...(ids(responsible, ['me', 'none']) ?? []),
                ...(responsible.includes('me') ? [context.userId] : []),
              ]),
            ],
            none: responsible.includes('none'),
          },
    priorities: query.priority ?? null,
    contractingTypeIds: query.contractingTypeId ?? null,
    modality:
      query.modalityId === undefined
        ? null
        : { ids: ids(query.modalityId, ['none']) ?? [], none: query.modalityId.includes('none') },
    originIds: query.originId ?? null,
    years: query.year ?? null,
    tagIds: query.tagId ?? null,
    overdue: query.overdue ?? null,
    targetDateOverdue: query.targetDateOverdue ?? null,
    createdFrom: query.createdFrom ?? null,
    createdTo: query.createdTo ?? null,
    targetDateFrom: query.targetDateFrom ?? null,
    targetDateTo: query.targetDateTo ?? null,
    estimatedValueMin: query.estimatedValueMin ?? null,
    estimatedValueMax: query.estimatedValueMax ?? null,
  };
}

/** Opções do filtro "Etapa": chaves distintas, com o nome da primeira ocorrência (lacuna 1). */
export function stageOptionsOf(stages: readonly ReleasedStage[]): ProcessStageOptionDto[] {
  const byKey = new Map<string, ProcessStageOptionDto>();
  for (const stage of stages) {
    if (!byKey.has(stage.key)) {
      byKey.set(stage.key, { key: stage.key, name: stage.name, groupLabel: stage.groupLabel });
    }
  }
  return [...byKey.values()];
}

@Injectable()
export class ListProcessesHandler {
  private readonly logger = new Logger('ProcessList');

  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly access: AccessFacade,
    private readonly presenter: ProcessListPresenter,
  ) {}

  execute(query: ProcessListQuery): Promise<ProcessListResult> {
    const filterKeys = filterKeysOf(query);
    return withSpan(
      'process.list',
      { 'cf.process.list.filters': filterKeys.join(',') },
      async () => {
        const startedAt = performance.now();
        try {
          const result = await this.run(query);
          const durationMs = Math.round(performance.now() - startedAt);
          const context = requireRequestContext();
          const fields = {
            filterKeys,
            sort: query.sort?.map((term) => `${term.direction === 'desc' ? '-' : ''}${term.field}`),
            qLength: query.q?.length ?? 0,
            page: query.page,
            pageSize: query.pageSize,
            resultCount: result.items.length,
            totalItems: result.meta.totalItems,
            durationMs,
            tenantId: context.tenantId,
            userId: context.actor.userId,
            correlationId: context.correlationId,
          };
          this.logger.log({ event: 'process.list', ...fields }, 'process.list');
          if (durationMs > PROCESS_LIST_SLOW_MS) {
            this.logger.warn({ event: 'process.list_slow', ...fields }, 'process.list_slow');
          }
          return result;
        } catch (error) {
          throw this.failure(error, query, filterKeys, Math.round(performance.now() - startedAt));
        }
      },
    );
  }

  private failure(
    error: unknown,
    query: ProcessListQuery,
    filterKeys: readonly string[],
    durationMs: number,
  ): unknown {
    const { correlationId } = requireRequestContext();
    if (isStatementTimeout(error)) {
      this.logger.warn(
        {
          event: 'process.list_slow',
          filterKeys,
          sort: query.sort?.map((term) => term.field),
          timedOut: true,
          durationMs,
          correlationId,
        },
        'process.list_slow',
      );
      return new DatabaseUnavailableError(error);
    }
    if (!(error instanceof ApiError) || error.status >= 500) {
      this.logger.error(
        {
          event: 'process.list_failed',
          errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
          cause: error instanceof Error ? error.name : typeof error,
          correlationId,
        },
        'process.list_failed',
      );
    }
    return error;
  }

  private async run(query: ProcessListQuery): Promise<ProcessListResult> {
    const context = requireRequestContext();
    const userId = context.actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const permissions = await this.access.effectivePermissions();
    const budget = await this.access.confidentialBudgetAccess();
    return this.transactions.read(async (tx) => {
      // DEC-024 cond. 4: sem `PROCESS_VIEW` por perfil, basta uma concessão `USER` ativa.
      if (!permissions.has('PROCESS_VIEW') && !(await this.processes.hasUserGrant(tx, userId))) {
        throw new ApiError('PERMISSION_DENIED', {
          detail: 'Você não tem acesso à lista de processos.',
          auditReasonCode: 'PROCESS_VIEW',
        });
      }
      const list = await this.presenter.loadContext(tx);
      const { now, timezone, today, stages } = list;
      const criteria = resolveCriteria(query, {
        userId,
        ownDepartmentIds: permissions.snapshot.ownDepartmentIds,
        stages,
      });
      const page = await this.processes.listProcesses(tx, {
        criteria,
        order: effectiveOrder(query.sort, criteria.search !== null),
        page: query.page,
        pageSize: query.pageSize,
        now,
        timezone,
        today,
        visibility: permissions.visibilityScope(),
        historicalDepartmentsCanView: list.historicalDepartmentsCanView,
        budget: { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
        statementTimeoutMs: PROCESS_LIST_STATEMENT_TIMEOUT_MS,
      });
      const items = await this.presenter.present(tx, page.rows, list);
      const valueFilter =
        criteria.estimatedValueMin !== null || criteria.estimatedValueMax !== null;
      const meta: ProcessListMeta = {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: page.totalItems,
        totalPages: Math.ceil(page.totalItems / query.pageSize),
        ...(query.includeStageOptions === true ? { stageOptions: stageOptionsOf(stages) } : {}),
        // FA-05: a nota aparece sempre que o filtro de valor está ativo sem POL-09 amplo.
        ...(valueFilter ? { valueFilterExcludesConfidential: !budget.scope.tenantWide } : {}),
        ...(budget.stepUpAvailable ? { confidentialStepUpAvailable: true } : {}),
      };
      return { items, meta };
    });
  }
}
