import { localDateOf } from '@contrataflow/types';
import type { ProcessListItemDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { PROCESS_CLOCK, TAG_REPOSITORY } from './ports.js';
import type { ProcessClock, ProcessListRow, TagRepository } from './ports.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { CatalogFacade } from '../../catalog/application/catalog.facade.js';
import type { CatalogItemRef } from '../../catalog/application/catalog.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ReleasedStage } from '../../workflow/application/workflow.facade.js';
import { deadlineDateRange, isProcessOverdue, stageDeadline } from '../domain/process-list.js';
import type { StageDeadlineInput } from '../domain/process-list.js';

/*
 * `ProcessListPresenter` (US-002 · reutilizado na exportação da US-003): o contexto da consulta
 * (relógio, fuso, etapas liberadas, configurações do tenant) e a apresentação das linhas — nomes
 * por lote (sem N+1), valor sigiloso mascarado por linha (POL-09) e o DTO calculado `deadline`.
 * Tudo no `tx` recebido (a exportação apresenta lote a lote dentro da leitura por cursor).
 */

const HISTORICAL_SETTING = 'access.historicalDepartmentsCanView';
const WARN_SETTING = 'deadlines.warnBeforeBusinessDays';
const SECRETARIAT_LABEL_SETTING = 'labels.secretariat';
const DEPARTMENT_LABEL_SETTING = 'labels.department';

export interface ProcessListContext {
  readonly now: Date;
  /** Hoje no fuso do tenant (`YYYY-MM-DD`). */
  readonly today: string;
  readonly timezone: string;
  readonly stages: readonly ReleasedStage[];
  readonly warnBeforeBusinessDays: number;
  /** `access.historicalDepartmentsCanView`. */
  readonly historicalDepartmentsCanView: boolean;
  /** `labels.secretariat`/`labels.department` (cabeçalho do CSV — US-003). */
  readonly labels: { readonly secretariat: string; readonly department: string };
}

@Injectable()
export class ProcessListPresenter {
  constructor(
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(TAG_REPOSITORY) private readonly tags: TagRepository,
    private readonly calendar: BusinessCalendarFacade,
    private readonly tenancy: TenancyFacade,
    private readonly workflow: WorkflowFacade,
    private readonly organization: OrganizationFacade,
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
  ) {}

  async loadContext(tx: TenantTx): Promise<ProcessListContext> {
    const settings = await this.tenancy.settingValues(tx, [
      HISTORICAL_SETTING,
      WARN_SETTING,
      SECRETARIAT_LABEL_SETTING,
      DEPARTMENT_LABEL_SETTING,
    ]);
    const timezone = await this.calendar.timezone(tx);
    const now = this.clock();
    const warn = settings.get(WARN_SETTING);
    const label = (key: string, fallback: string) => {
      const value = settings.get(key);
      return typeof value === 'string' && value !== '' ? value : fallback;
    };
    return {
      now,
      today: localDateOf(now, timezone),
      timezone,
      stages: await this.workflow.releasedStages(tx),
      warnBeforeBusinessDays: typeof warn === 'number' ? warn : 2,
      historicalDepartmentsCanView: settings.get(HISTORICAL_SETTING) !== false,
      labels: {
        secretariat: label(SECRETARIAT_LABEL_SETTING, 'Secretaria'),
        department: label(DEPARTMENT_LABEL_SETTING, 'Setor'),
      },
    };
  }

  /** Nomes por lote (sem N+1), valor mascarado por linha e `deadline`. */
  async present(
    tx: TenantTx,
    rows: readonly ProcessListRow[],
    context: ProcessListContext,
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
    // Etiquetas (US-007) de todas as linhas numa só consulta.
    const tagsByProcess = await this.tags.forProcesses(
      tx,
      rows.map((row) => row.id),
    );
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
        tags: (tagsByProcess.get(row.id) ?? []).map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          isActive: tag.isActive,
        })),
        openedAt: row.openedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }
}
