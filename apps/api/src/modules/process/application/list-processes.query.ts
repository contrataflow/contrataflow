import { withSpan } from '@contrataflow/observability';
import { localDateOf } from '@contrataflow/types';
import type {
  ProcessListItemDto,
  ProcessListMeta,
  ProcessListQuery,
  ProcessStageOptionDto,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isStatementTimeout } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessClock,
  ProcessListRow,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { CatalogItemRef } from '../../catalog/application/catalog.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ReleasedStage } from '../../workflow/application/workflow.facade.js';
import {
  deadlineDateRange,
  effectiveOrder,
  isProcessOverdue,
  stageDeadline,
} from '../domain/process-list.js';
import type { ProcessListCriteria, StageDeadlineInput } from '../domain/process-list.js';

/*
 * `ListProcessesHandler` (US-002 · PRC-01): lista paginada, filtrada e ordenada dos processos que
 * o usuário vê. Autoriza (`PROCESS_VIEW` em algum escopo OU concessão `USER` — DEC-024 cond. 4),
 * resolve os valores reservados e as chaves de etapa, consulta página + total num snapshot e
 * apresenta (`ProcessListPresenter`: nomes por lote, mascaramento POL-09 por linha e o DTO
 * `deadline`). Somente leitura; nenhum evento. Logs sem o texto da busca nem valores.
 */

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';
const WARN_SETTING = 'deadlines.warnBeforeBusinessDays';
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

/** Valores reservados e chaves de etapa → critérios resolvidos (RN-PROC-21/22). */
export function resolveCriteria(
  query: ProcessListQuery,
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
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly access: AccessFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly tenancy: TenancyFacade,
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
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
      const settings = await this.tenancy.settingValues(tx, [HISTORICAL_SETTING, WARN_SETTING]);
      const timezone = await this.calendar.timezone(tx);
      const now = this.clock();
      const today = localDateOf(now, timezone);
      const stages = await this.workflow.releasedStages(tx);
      const criteria = resolveCriteria(query, {
        userId,
        ownDepartmentIds: permissions.snapshot.ownDepartmentIds,
        stages,
      });
      const historicalDepartmentsCanView = settings.get(HISTORICAL_SETTING) !== false;
      const page = await this.processes.listProcesses(tx, {
        criteria,
        order: effectiveOrder(query.sort, criteria.search !== null),
        page: query.page,
        pageSize: query.pageSize,
        now,
        timezone,
        today,
        visibility: permissions.visibilityScope(),
        historicalDepartmentsCanView,
        budget: { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
        statementTimeoutMs: PROCESS_LIST_STATEMENT_TIMEOUT_MS,
      });
      const warn = settings.get(WARN_SETTING);
      const items = await this.present(tx, page.rows, {
        now,
        today,
        timezone,
        stages,
        warnBeforeBusinessDays: typeof warn === 'number' ? warn : 2,
      });
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

  /** `ProcessListPresenter`: nomes por lote (sem N+1), valor mascarado por linha e `deadline`. */
  private async present(
    tx: TenantTx,
    rows: readonly ProcessListRow[],
    context: {
      readonly now: Date;
      readonly today: string;
      readonly timezone: string;
      readonly stages: readonly ReleasedStage[];
      readonly warnBeforeBusinessDays: number;
    },
  ): Promise<ProcessListItemDto[]> {
    if (rows.length === 0) return [];
    const departmentNames = await this.organization.departmentNames(tx, [
      ...new Set(
        rows.flatMap((row) => [
          row.requestingSecretariatId,
          row.requestingDepartmentId,
          row.currentDepartmentId,
        ]),
      ),
    ]);
    const userNames = await this.identity.userDisplayNames(tx, [
      ...new Set(
        rows.flatMap((row) => (row.currentResponsibleId ? [row.currentResponsibleId] : [])),
      ),
    ]);
    const catalog = new Map<string, CatalogItemRef>();
    for (const id of new Set(
      rows.flatMap((row) => [row.contractingTypeId, row.modalityId, row.originId]),
    )) {
      if (id === null) continue;
      const item = await this.catalog.find(tx, id);
      if (item) catalog.set(id, item);
    }
    const organizations = new Map<string, string>();
    for (const id of new Set(rows.map((row) => row.organizationId))) {
      organizations.set(id, (await this.tenancy.organizationSummary(tx, id))?.shortName ?? '');
    }
    const stageById = new Map(context.stages.map((stage) => [stage.id, stage]));
    const localDate = (instant: Date) => localDateOf(instant, context.timezone);
    const inputOf = (row: ProcessListRow): StageDeadlineInput => ({
      dueAt: row.currentStageDueAt,
      slaType: row.slaType,
      isPaused: row.stagePausedAt !== null,
      isOverdue: isProcessOverdue(row, context.now),
      overdueSince: row.overdueSince,
    });
    const inputs = rows.map(inputOf);

    const range = deadlineDateRange(inputs, { today: context.today, localDate });
    const businessDays = new Set(
      await this.calendar.listBusinessDaysBetween(tx, range.from, range.to),
    );
    const calendar = {
      today: context.today,
      localDate,
      isBusinessDay: (date: string) => businessDays.has(date),
      warnBeforeBusinessDays: context.warnBeforeBusinessDays,
    };
    const unit = (id: string) => ({ id, name: departmentNames.get(id) ?? id });
    const catalogRef = (id: string) => {
      const item = catalog.get(id);
      return { id, code: item?.code ?? '', label: item?.label ?? '' };
    };
    return rows.map((row) => {
      const stage =
        row.currentWorkflowStageId === null ? undefined : stageById.get(row.currentWorkflowStageId);
      const masked = row.isBudgetConfidential && !row.canViewBudget;
      return {
        id: row.id,
        code: row.code,
        number: row.number,
        year: row.year,
        internalCode: row.internalCode,
        title: row.title,
        status: row.status,
        priority: row.priority,
        organization: {
          id: row.organizationId,
          shortName: organizations.get(row.organizationId) ?? '',
        },
        requestingSecretariat: unit(row.requestingSecretariatId),
        requestingDepartment: unit(row.requestingDepartmentId),
        currentStage: stage ? { key: stage.key, name: stage.name } : null,
        currentDepartment: unit(row.currentDepartmentId),
        currentResponsible:
          row.currentResponsibleId === null
            ? null
            : {
                id: row.currentResponsibleId,
                name: userNames.get(row.currentResponsibleId) ?? row.currentResponsibleId,
              },
        deadline: stageDeadline(inputOf(row), calendar),
        contractingType: catalogRef(row.contractingTypeId),
        modality: row.modalityId === null ? null : catalogRef(row.modalityId),
        origin: catalogRef(row.originId),
        isBudgetConfidential: row.isBudgetConfidential,
        estimatedValue: masked ? null : row.estimatedValue,
        estimatedValueMasked: masked,
        targetDate: row.targetDate,
        overdueSince: row.overdueSince?.toISOString() ?? null,
        tags: [],
        openedAt: row.openedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }
}
