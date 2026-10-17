import { withSpan } from '@contrataflow/observability';
import { localDateOf } from '@contrataflow/types';
import type {
  ActionEntry,
  ProcessStageEntryDto,
  ProcessSummaryDto,
  SummaryApproval,
  SummaryDocument,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { ConfidentialViewRecorder } from './confidential-view.recorder.js';
import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessRuntimeLoader } from './process-runtime.loader.js';
import { ProcessViewerResolver } from './process-viewer.js';
import type { ResolvedViewer } from './process-viewer.js';
import { processNotFoundError } from './process.errors.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { PendingApprovalFact } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { WorkflowSnapshot } from '../../workflow/application/workflow.facade.js';
import {
  canViewConfidentialBudget,
  deadlineDateRange,
  isProcessOverdue,
  stageDeadline,
} from '../domain/process-list.js';
import type { StageDeadlineInput } from '../domain/process-list.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import {
  approverLabelOf,
  isDesignatedApprover,
  isFinalStatus,
  pendingOf,
  selectPrimaryAction,
  stageEntriesOf,
  targetOf,
} from '../domain/process-summary.js';
import type { ApprovalForPanel, ApproverNames } from '../domain/process-summary.js';
import { canViewProcess } from '../domain/process-visibility.js';

/*
 * Painel situacional do processo (US-004 · SCR-006): PRC-07 (`summary` — as 7 perguntas de
 * DEC-180), PRC-10 (`stages` — stepper) e as ações de PRC-04 (`meta.allowedActions`). A
 * visibilidade (DEC-024 · RN-PROC-47) é conferida aqui, sobre o runtime lido no mesmo `tx`
 * (`ProcessPanelReader.load` → 404 `PROCESS_NOT_FOUND`). Tudo numa transação
 * `REPEATABLE READ READ ONLY` (RN-PROC-56): etapa, responsável, checklist, documentos e aprovações
 * do mesmo instante. Composição só por fachadas (DEC-041); a única escrita possível é a auditoria
 * `process.confidential_view`, depois, em transação curta própria.
 */

const WARN_SETTING = 'deadlines.warnBeforeBusinessDays';
/** Acima disto: `warn process.summary_slow` (C2 · SLO-04: p95 ≤ 800 ms). */
export const PROCESS_SUMMARY_SLOW_MS = 800;

/** POL-09 (RN-PROC-25/55) para o processo: permissão com escopo que o cubra ou custódia atual. */
async function budgetVisibleFor(
  access: AccessFacade,
  rows: ProcessAggregateRows,
  runtime: ProcessRuntime,
): Promise<boolean> {
  if (!rows.process.isBudgetConfidential) return true;
  const budget = await access.confidentialBudgetAccess();
  return canViewConfidentialBudget(
    rows.process,
    { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
    runtime.access.departmentIds,
  );
}

/** O que o painel precisa saber do usuário para POL-03 (aprovador designado). */
function approverViewerOf(viewer: ResolvedViewer) {
  return {
    userId: viewer.engine.userId,
    headOfDepartmentIds: viewer.engine.headOfDepartmentIds,
    roleKeys: requireRequestContext().roleKeys ?? [],
  };
}

/** Leituras comuns do painel no `tx` do chamador: agregado, runtime e quem consulta. */
@Injectable()
export class ProcessPanelReader {
  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly runtimes: ProcessRuntimeLoader,
    private readonly viewers: ProcessViewerResolver,
    private readonly workflow: WorkflowFacade,
    private readonly approvals: ApprovalFacade,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  /**
   * O processo VISÍVEL ao usuário (DEC-024 — escopo de `PROCESS_VIEW`, concessão própria ou
   * participação: o aprovador designado chega pelo link da aprovação) ou 404 `PROCESS_NOT_FOUND`,
   * igual ao inexistente e sem `access.denied` (a existência não é revelada — RN-PROC-47).
   */
  async load(tx: TenantTx, processId: string) {
    const rows = await this.processes.loadAggregate(tx, processId);
    if (rows === null) throw processNotFoundError();
    const runtime = await this.runtimes.fromAggregate(tx, rows);
    const viewer = await this.viewers.resolve(tx);
    if (!canViewProcess(runtime.access, viewer.visibility, runtime.organizationId ?? null)) {
      throw processNotFoundError();
    }
    return { rows, runtime, viewer };
  }

  /** PRC-08 do usuário (o mesmo motor dos comandos). */
  actions(tx: TenantTx, runtime: ProcessRuntime, viewer: ResolvedViewer): Promise<ActionEntry[]> {
    return this.workflow.getAvailableActions(tx, executionStateOf(runtime), viewer.engine);
  }

  /** Aprovações pendentes com o aprovador designado resolvido (rótulo e POL-03). */
  async pendingApprovals(tx: TenantTx, processId: string, viewer: ResolvedViewer) {
    const approvals = await this.approvals.listPendingForProcess(tx, processId);
    const names = await this.approverNames(tx, approvals);
    const who = approverViewerOf(viewer);
    return approvals.map((approval) => ({
      ...approval,
      label: approverLabelOf(approval, names),
      isMine: isDesignatedApprover(approval, who, names),
    }));
  }

  canSeeBudget(rows: ProcessAggregateRows, runtime: ProcessRuntime): Promise<boolean> {
    return budgetVisibleFor(this.access, rows, runtime);
  }

  private async approverNames(
    tx: TenantTx,
    approvals: readonly PendingApprovalFact[],
  ): Promise<ApproverNames> {
    const ids = (pick: (approval: PendingApprovalFact) => string | null) => [
      ...new Set(approvals.flatMap((approval) => pick(approval) ?? [])),
    ];
    return {
      users: await this.identity.userDisplayNames(
        tx,
        ids((approval) => approval.approverUserId),
      ),
      roles: await this.access.roleSummaries(
        tx,
        ids((approval) => approval.approverRoleId),
      ),
      departments: await this.organization.departmentNames(
        tx,
        ids((approval) => approval.approverDepartmentId),
      ),
    };
  }
}

/** `GetProcessSummaryQuery` — PRC-07 (RN-PROC-48..58). */
@Injectable()
export class GetProcessSummaryQuery {
  private readonly logger = new Logger('ProcessSummary');

  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    private readonly panel: ProcessPanelReader,
    private readonly workflow: WorkflowFacade,
    private readonly documents: DocumentFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly confidentialViews: ConfidentialViewRecorder,
  ) {}

  execute(processId: string): Promise<ProcessSummaryDto> {
    return withSpan('process.summary', { 'cf.process.id': processId }, async () => {
      const startedAt = performance.now();
      const timings: Record<string, number> = {};
      const timed = async <T>(block: string, work: () => Promise<T>): Promise<T> => {
        const blockStart = performance.now();
        try {
          return await withSpan(`process.summary.${block}`, {}, work);
        } finally {
          timings[block] = Math.round(performance.now() - blockStart);
        }
      };
      const { summary, rulesEvaluated } = await this.transactions.snapshot((tx) =>
        this.compose(tx, processId, timed),
      );
      if (summary.header.isBudgetConfidential && !summary.header.estimatedValueMasked) {
        await this.confidentialViews.recordOnce(
          { id: processId, code: summary.header.code },
          'PRC-07',
        );
      }
      this.logged(processId, summary, rulesEvaluated, timings, startedAt);
      return summary;
    });
  }

  private async compose(
    tx: TenantTx,
    processId: string,
    timed: <T>(block: string, work: () => Promise<T>) => Promise<T>,
  ): Promise<{ summary: ProcessSummaryDto; rulesEvaluated: number }> {
    const { rows, runtime, viewer } = await timed('process', () => this.panel.load(tx, processId));
    const { process, situation } = rows;
    const final = isFinalStatus(process.status);
    const definition = await this.workflow.publishedDefinition(process.workflowVersionId);
    const stage =
      definition?.stages.find((candidate) => candidate.id === process.currentWorkflowStageId) ??
      null;
    const [actions, violations] = await timed('rules', async () => [
      await this.panel.actions(tx, runtime, viewer),
      await this.workflow.evaluateRules(tx, executionStateOf(runtime)),
    ]);
    const canSeeBudget = await this.panel.canSeeBudget(rows, runtime);
    const documents = await timed('documents', async () =>
      (await this.documents.listForSummary(tx, processId)).map((document): SummaryDocument => ({
        ...document,
        restricted: document.confidentiality === 'RESTRICTED' && !canSeeBudget,
      })),
    );
    const approvals = await timed('approvals', () =>
      this.panel.pendingApprovals(tx, processId, viewer),
    );

    const now = this.clock();
    const timezone = await this.calendar.timezone(tx);
    const today = localDateOf(now, timezone);
    const departmentNames = await this.organization.departmentNames(tx, [
      process.currentDepartmentId,
    ]);
    const userNames = await this.identity.userDisplayNames(
      tx,
      process.currentResponsibleId === null ? [] : [process.currentResponsibleId],
    );
    const organization = await this.tenancy.organizationSummary(tx, process.organizationId);
    const primaryOrganizationId = await this.tenancy.primaryOrganizationId(tx);
    const masked = process.isBudgetConfidential && !canSeeBudget;
    const department = {
      id: process.currentDepartmentId,
      name: departmentNames.get(process.currentDepartmentId) ?? process.currentDepartmentId,
    };
    const panelApprovals: ApprovalForPanel[] = approvals;
    const approvalOfStage =
      approvals.find((approval) => approval.processStageId === process.currentStageId) ??
      approvals[0];

    const summary: ProcessSummaryDto = {
      header: {
        code: process.code,
        title: process.title,
        status: process.status,
        priority: process.priority,
        tags: [],
        isBudgetConfidential: process.isBudgetConfidential,
        estimatedValue: masked ? null : process.estimatedValue,
        estimatedValueMasked: masked,
        estimatedValueSource: process.estimatedValueSource,
        organization: { id: process.organizationId, shortName: organization?.shortName ?? '' },
        showOrganization:
          primaryOrganizationId !== null && primaryOrganizationId !== process.organizationId,
      },
      where: {
        stage:
          stage === null
            ? null
            : { key: stage.key, name: stage.name, type: stage.type, groupLabel: stage.groupLabel },
        department,
        status: process.status,
        statusBeforeSuspension: situation.statusBeforeSuspension,
        suspensionReason: situation.suspensionReason,
        suspendedAt: situation.suspendedAt?.toISOString() ?? null,
        completedAt: situation.completedAt?.toISOString() ?? null,
        canceledAt: situation.canceledAt?.toISOString() ?? null,
        cancellationReason: situation.cancellationReason,
      },
      responsible: {
        user:
          process.currentResponsibleId === null
            ? null
            : {
                id: process.currentResponsibleId,
                name: userNames.get(process.currentResponsibleId) ?? process.currentResponsibleId,
                jobTitle: null,
              },
        queueDepartment: process.currentResponsibleId === null && !final ? department : null,
        since: situation.assignmentSince?.toISOString() ?? null,
        approver:
          process.status === 'AWAITING_APPROVAL' && approvalOfStage !== undefined
            ? {
                approvalId: approvalOfStage.id,
                label: approvalOfStage.label,
                isMine: approvalOfStage.isMine,
              }
            : null,
      },
      pending: pendingOf(violations, documents),
      nextStep: {
        action: selectPrimaryAction({
          status: process.status,
          actions,
          approvals: panelApprovals,
        }),
        instructions: stage?.instructions ?? null,
      },
      deadline: final
        ? null
        : await this.deadlineOf(tx, rows, stage?.slaType ?? null, { now, today, timezone }),
      target: targetOf(process.targetDate, process.status, today),
      documents,
      approvals: approvals.map((approval): SummaryApproval => ({
        id: approval.id,
        title: approval.title,
        approverLabel: approval.label,
        requestedAt: approval.requestedAt.toISOString(),
        dueAt: approval.dueAt?.toISOString() ?? null,
        isOverdue: approval.dueAt !== null && approval.dueAt.getTime() < now.getTime(),
        isMine: approval.isMine,
      })),
      counts: {
        documents: documents.length,
        items: runtime.ruleProcess.itemsCount,
        comments: 0,
        // US-012: participações ativas e válidas (as vencidas já saem do runtime — RN-PROC-135).
        participants: runtime.access.participations?.length ?? 0,
      },
      version: process.version,
    };
    return { summary, rulesEvaluated: rulesOfStage(definition, process.currentWorkflowStageId) };
  }

  /** DTO `deadline` da etapa ativa (US-002 — `StageDeadlineCalculator`). */
  private async deadlineOf(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    stageSlaType: StageDeadlineInput['slaType'],
    clock: { readonly now: Date; readonly today: string; readonly timezone: string },
  ) {
    const { process, situation } = rows;
    const active = rows.stages.find((pass) => pass.status === 'ACTIVE');
    const input: StageDeadlineInput = {
      dueAt: process.currentStageDueAt,
      slaType: active?.slaType ?? stageSlaType,
      isPaused: (active?.pausedAt ?? null) !== null || process.status === 'SUSPENDED',
      isOverdue: isProcessOverdue(
        {
          status: process.status,
          overdueSince: situation.overdueSince,
          currentStageDueAt: process.currentStageDueAt,
        },
        clock.now,
      ),
      overdueSince: situation.overdueSince,
    };
    const localDate = (instant: Date) => localDateOf(instant, clock.timezone);
    const range = deadlineDateRange([input], { today: clock.today, localDate });
    const businessDays = new Set(
      await this.calendar.listBusinessDaysBetween(tx, range.from, range.to),
    );
    const warn = (await this.tenancy.settingValues(tx, [WARN_SETTING])).get(WARN_SETTING);
    return stageDeadline(input, {
      today: clock.today,
      localDate,
      isBusinessDay: (date) => businessDays.has(date),
      warnBeforeBusinessDays: typeof warn === 'number' ? warn : 2,
    });
  }

  /** `info process.summary` e `warn process.summary_slow` — nunca título, valores nem instruções. */
  private logged(
    processId: string,
    summary: ProcessSummaryDto,
    rulesEvaluated: number,
    timings: Readonly<Record<string, number>>,
    startedAt: number,
  ): void {
    const durationMs = Math.round(performance.now() - startedAt);
    const fields = {
      processId,
      durationMs,
      rulesEvaluated,
      documentsCount: summary.documents.length,
      pendingApprovalsCount: summary.approvals.length,
      correlationId: requireRequestContext().correlationId,
    };
    this.logger.log({ event: 'process.summary', ...fields }, 'process.summary');
    if (durationMs > PROCESS_SUMMARY_SLOW_MS) {
      this.logger.warn(
        { event: 'process.summary_slow', ...fields, blocks: timings },
        'process.summary_slow',
      );
    }
  }
}

/** Regras ativas avaliadas na etapa atual (`STAGE_EXIT` dela e `TRANSITION` das saídas). */
function rulesOfStage(definition: WorkflowSnapshot | null, stageId: string | null): number {
  if (definition === null || stageId === null) return 0;
  const exits = new Set(
    definition.transitions
      .filter((transition) => transition.fromStageId === stageId)
      .map((transition) => transition.id),
  );
  return definition.rules.filter(
    (rule) =>
      rule.isActive &&
      (rule.stageId === stageId || (rule.transitionId !== null && exits.has(rule.transitionId))),
  ).length;
}

/** `ListProcessStagesQuery` — PRC-10 (RN-PROC-52): etapas da versão fixada e passagens. */
@Injectable()
export class ListProcessStagesQuery {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    private readonly panel: ProcessPanelReader,
    private readonly workflow: WorkflowFacade,
    private readonly identity: IdentityFacade,
    private readonly organization: OrganizationFacade,
  ) {}

  execute(processId: string): Promise<ProcessStageEntryDto[]> {
    return this.transactions.snapshot(async (tx) => {
      const { rows } = await this.panel.load(tx, processId);
      const definition = await this.workflow.publishedDefinition(rows.process.workflowVersionId);
      const departments = await this.organization.departmentNames(tx, [
        ...new Set(rows.stages.map((pass) => pass.departmentId)),
      ]);
      const users = await this.identity.userDisplayNames(tx, [
        ...new Set(rows.stages.flatMap((pass) => pass.assigneeId ?? [])),
      ]);
      return stageEntriesOf(
        definition?.stages ?? [],
        rows.stages.map((pass) => ({
          processStageId: pass.id,
          workflowStageId: pass.workflowStageId,
          sequence: pass.sequence,
          status: pass.status,
          department: {
            id: pass.departmentId,
            name: departments.get(pass.departmentId) ?? pass.departmentId,
          },
          assignee:
            pass.assigneeId === null
              ? null
              : { id: pass.assigneeId, name: users.get(pass.assigneeId) ?? pass.assigneeId },
          enteredAt: pass.enteredAt,
          exitedAt: pass.exitedAt,
          dueAt: pass.dueAt,
          dueDateOverridden: pass.dueDateOverridden,
          overdueSince: pass.overdueSince,
        })),
        rows.process.status,
      );
    });
  }
}
