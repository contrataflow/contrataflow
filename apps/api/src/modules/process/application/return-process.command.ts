import { withSpan } from '@contrataflow/observability';
import {
  dueDateOverrideIssues,
  movementMetadataSchema,
  MOVEMENT_METADATA_VERSION,
  PROCESS_FORWARD_MESSAGES,
  PROCESS_RETURN_MESSAGES,
} from '@contrataflow/validation';
import type { MovementMetadata, ReturnProcess, ReturnedProcessDto } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { FORWARD_LOCK_WAIT_WARN_MS } from './forward-process.command.js';
import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessStageRow,
  ProcessTransactions,
} from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import {
  processNotFoundError,
  processNotReturnable,
  recordProcessReturned,
  returnDueDateNotAllowed,
  returnNotCustodian,
  returnTargetNotAvailable,
  returnVersionConflict,
  stageChanged,
  transitionNotAvailable,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { StageTransitionService } from './stage-transition.service.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type { ReturnEvaluation } from '../../workflow/application/workflow.facade.js';
import {
  canReturnInStatus,
  resolvePreviousAssignee,
  returnDepartmentOf,
} from '../domain/process-return.js';
import { isProcessCustodian } from '../domain/process-update.js';
import type { Process } from '../domain/process.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface ReturnProcessInput {
  readonly processId: string;
  readonly body: ReturnProcess;
  /** `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `process.return`). */
  readonly idempotencyKey: string | null;
}

export interface ReturnedProcess {
  readonly dto: ReturnedProcessDto;
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly resolvedAssigneeId: string | null;
  readonly lockWaitMs: number;
}

interface Prepared {
  readonly now: Date;
}

/** Prazo da passagem de destino (RN-TRAM-26). */
interface ReturnDueDate {
  readonly dueAt: Date | null;
  readonly computedDueAt: Date | null;
  readonly overridden: boolean;
}

/**
 * `ReturnProcessCommand` — PRC-20 (US-048 · fluxo principal, passo 5): o padrão
 * `TransactionalCommandHandler` com o `StageTransitionService` da US-047. Em UMA transação do
 * tenant: `SELECT … FOR UPDATE` no processo e visibilidade (404) → etapa esperada, se enviada (409
 * `STAGE_CHANGED`), ANTES do `If-Match` (412 — RN-TRAM-30) → `PROCESS_RETURN` cobrindo o processo,
 * status `IN_PROGRESS` (409) e custódia (403 auditado — RN-TRAM-23) → destino já percorrido e
 * configurado na `RETURN` da etapa atual (422 `TRANSITION_NOT_AVAILABLE` — RN-TRAM-24) → unidade
 * (RN-TRAM-27), responsável `PREVIOUS_ASSIGNEE` (RN-TRAM-28) e prazo (RN-TRAM-26) → mudança de
 * etapa (passagem `RETURNED`, responsabilidade `RETURN`, tramitação `RETURN`, processo `RETURNED`)
 * → `process.return` e eventos (timeline e `ProcessAccess` no mesmo `tx`). Nenhum documento muda de
 * status (RN-TRAM-29 · POL-11). Qualquer falha desfaz tudo. O motivo nunca vai a log nem a payload.
 */
@Injectable()
export class ReturnProcessCommand extends TransactionalCommandHandler<
  ReturnProcessInput,
  Prepared,
  ReturnedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly organization: OrganizationFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly transitions: StageTransitionService,
    private readonly support: StageTransitionSupport,
  ) {
    super('process.return', transactions);
  }

  override async execute(input: ReturnProcessInput): Promise<ReturnedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // Recusa de regra (4xx): só o código — nunca o motivo da devolução.
        this.logger.log(
          {
            event: 'process.return_rejected',
            processId: input.processId,
            code: error.code,
            correlationId: requireRequestContext().correlationId,
          },
          'process.return_rejected',
        );
      }
      throw error;
    }
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: ReturnProcessInput,
    { now }: Prepared,
  ): Promise<ReturnedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';
    const { body } = input;

    // 5.1 — trava o processo antes de ler: o estado lido é o do vencedor de qualquer corrida.
    const lockStartedAt = performance.now();
    if (!(await this.processes.lockForUpdate(tx, input.processId))) throw processNotFoundError();
    const lockWaitMs = Math.round(performance.now() - lockStartedAt);
    if (lockWaitMs > FORWARD_LOCK_WAIT_WARN_MS) {
      this.logger.warn(
        {
          event: 'process.lock_wait',
          processId: input.processId,
          lockWaitMs,
          correlationId: context.correlationId,
        },
        'process.lock_wait',
      );
    }
    const { rows, runtime, viewer } = await this.panel.load(tx, input.processId);
    const process = rows.process;

    // RN-TRAM-30 — etapa esperada (se enviada) ANTES do If-Match.
    if (body.expectedStageId !== undefined && process.currentStageId !== body.expectedStageId) {
      throw stageChanged(
        process.currentStageId,
        await this.support.lastWriter(tx, process),
        PROCESS_RETURN_MESSAGES.stageChanged,
      );
    }
    if (input.expectedVersion !== process.version) {
      throw returnVersionConflict(input.expectedVersion, process.version);
    }

    // 5.2 — PROCESS_RETURN cobrindo o processo, status e custódia (RN-TRAM-23 · POL-01).
    await this.access.assertCanOnProcess('PROCESS_RETURN', accessTargetOf(runtime));
    if (!canReturnInStatus(process.status)) throw processNotReturnable(process.status);
    if (!isProcessCustodian(process, viewer.engine)) throw returnNotCustodian();
    const active = activePassOf(rows, process);

    // 5.3 — destino já percorrido e configurado na RETURN da etapa atual (RN-TRAM-24).
    const evaluation = await withSpan('process.return.target', {}, () =>
      this.workflow.evaluateReturn(tx, executionStateOf(runtime), {
        targetStageId: body.targetStageId,
      }),
    );
    if (evaluation === null) throw returnTargetNotAvailable();
    const { transition, fromStage, toStage } = evaluation;

    // 5.5 — unidade (RN-TRAM-27), responsável (RN-TRAM-28) e prazo (RN-TRAM-26).
    const toDepartmentId = await this.destination(tx, evaluation, process);
    const toUserId = await this.previousAssignee(tx, process, toStage.id, toDepartmentId, now);
    const due = await this.dueDate(tx, evaluation, body, now);

    const labels = await this.support.labels(tx, {
      fromStage: fromStage.name,
      toStage: toStage.name,
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId,
      fromUserId: process.currentResponsibleId,
      toUserId,
    });
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      computedDueAt: due.computedDueAt?.toISOString() ?? null,
      dueDateOverridden: due.overridden,
      labels,
      clientChannel: 'WEB',
    });

    // 5.4–5.10 — passagem RETURNED, nova passagem/responsabilidade RETURN, tramitação e processo.
    const plan = await this.transitions.apply(tx, {
      transition: {
        process,
        active: {
          id: active.id,
          workflowStageId: active.workflowStageId,
          sequence: active.sequence,
          departmentId: active.departmentId,
          assigneeId: active.assigneeId,
        },
        lastStageSequence: Math.max(...rows.stages.map((stage) => stage.sequence)),
        lastMovementSequence: await this.processes.lastMovementSequence(tx, process.id),
        action: 'RETURN',
        closeAs: 'RETURNED',
        transitionId: transition.id,
        toWorkflowStageId: toStage.id,
        toDepartmentId,
        toUserId,
        assignedById: null,
        assignmentType: 'RETURN',
        slaDays: toStage.slaDays,
        slaType: toStage.slaType,
        dueAt: due.dueAt,
        dueDateOverrideReason: due.overridden
          ? PROCESS_RETURN_MESSAGES.dueDateOverrideReason
          : null,
        statusTo: 'RETURNED',
        comment: body.comment,
        // RN-TRAM-29 (POL-11): a devolução não leva nem altera documentos.
        documents: [],
        approvalId: null,
        metadata,
        numbering: null,
        actor: {
          userId,
          ip: context.ip,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        },
        now,
        ids: { stage: newId(), assignment: newId(), movement: newId() },
      },
      cause: 'RETURN',
      statusCause: 'RETURN',
      fromStageKey: fromStage.key,
      toStage: { key: toStage.key, type: toStage.type },
      requestedApprovalId: null,
    });

    // 5.10 — auditoria (a timeline e o ProcessAccess já vieram com o ProcessStageChanged).
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.return',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'status', old: process.status, new: updated.status },
        { path: 'currentStageId', old: process.currentStageId, new: updated.currentStageId },
        {
          path: 'currentResponsibleId',
          old: process.currentResponsibleId,
          new: updated.currentResponsibleId,
        },
      ],
      metadata: {
        processCode: updated.code,
        movementId: plan.movement.id,
        transitionKey: transition.key,
        fromStageKey: fromStage.key,
        toStageKey: toStage.key,
        commentLength: body.comment.length,
        dueDateOverridden: due.overridden,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // POL-09 sobre o NOVO estado (quem devolveu perdeu a custódia).
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process: updated }, runtime);
    const dto = await this.presenter.present(tx, updated, canSeeBudget);
    return {
      dto: {
        ...dto,
        movement: { id: plan.movement.id, sequence: plan.movement.sequence },
        statusFrom: process.status,
      },
      fromStageKey: fromStage.key,
      toStageKey: toStage.key,
      resolvedAssigneeId: toUserId,
      lockWaitMs,
    };
  }

  protected override committed(result: ReturnedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessReturned(result.resolvedAssigneeId !== null, durationMs);
    // Nunca logar o motivo (`comment`), valores nem IP (story · Logs).
    this.logger.log(
      {
        event: 'process.returned',
        processId: result.dto.id,
        movementId: result.dto.movement.id,
        fromStageKey: result.fromStageKey,
        toStageKey: result.toStageKey,
        resolvedAssigneeId: result.resolvedAssigneeId,
        durationMs,
        lockWaitMs: result.lockWaitMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.returned',
    );
  }

  /**
   * RN-TRAM-27: unidade pela `departmentResolution` da etapa de destino; `CHOSEN_ON_FORWARD`
   * reaproveita a da última passagem. Sem unidade resolvível ou unidade inativa = destino
   * indisponível (o mesmo motivo do encaminhamento).
   */
  private async destination(
    tx: TenantTx,
    { toStage, lastPass }: ReturnEvaluation,
    process: Process,
  ): Promise<string> {
    const resolved = this.workflow.resolveStageDepartment(toStage, process);
    const departmentId = returnDepartmentOf(
      toStage.departmentResolution,
      resolved.departmentId,
      lastPass.departmentId,
    );
    if (departmentId === null) {
      throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
    }
    const reference = (await this.organization.departmentReferences(tx, [departmentId])).get(
      departmentId,
    );
    if (reference?.isActive !== true) {
      throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
    }
    return departmentId;
  }

  /**
   * RN-TRAM-28 (FA-01): o responsável mais recente das passagens anteriores pela etapa, se ainda
   * elegível na unidade de destino (RN-TRAM-08); senão, a fila da unidade (`warn`).
   */
  private async previousAssignee(
    tx: TenantTx,
    process: Process,
    workflowStageId: string,
    toDepartmentId: string,
    now: Date,
  ): Promise<string | null> {
    const history = await this.processes.previousAssignments(tx, process.id, workflowStageId);
    const candidate = resolvePreviousAssignee(history);
    const eligible =
      candidate !== null &&
      (await this.support.isEligibleAssignee(tx, candidate, toDepartmentId, now));
    if (eligible) return candidate;
    this.logger.warn(
      {
        event: 'return.previous_assignee_not_found',
        processId: process.id,
        candidateIneligible: candidate !== null,
        correlationId: requireRequestContext().correlationId,
      },
      'return.previous_assignee_not_found',
    );
    return null;
  }

  /**
   * RN-TRAM-26 (V-04 · FA-02): com SLA, o fim do N-ésimo dia útil (ou corrido) depois de agora; o
   * prazo informado só com `allowDueDateOverride`, entre hoje e hoje + 365, ao fim do dia.
   */
  private async dueDate(
    tx: TenantTx,
    { transition, toStage }: ReturnEvaluation,
    body: ReturnProcess,
    now: Date,
  ): Promise<ReturnDueDate> {
    const computed =
      toStage.slaDays === null
        ? null
        : await this.calendar.addBusinessDays(tx, now, toStage.slaDays, toStage.slaType);
    if (body.dueAt === undefined)
      return { dueAt: computed, computedDueAt: computed, overridden: false };
    if (!transition.allowDueDateOverride) throw returnDueDateNotAllowed();
    const date = DATE_ONLY.test(body.dueAt)
      ? body.dueAt
      : await this.calendar.localDate(tx, new Date(body.dueAt));
    const issues = dueDateOverrideIssues(date, await this.calendar.localDate(tx, now));
    if (issues.length > 0) {
      throw validationError(
        issues.map((issue) => ({
          field: issue.field,
          code: issue.code,
          message: PROCESS_RETURN_MESSAGES.dueDateRange,
        })),
      );
    }
    return {
      dueAt: await this.calendar.endOfLocalDay(tx, date),
      computedDueAt: computed,
      overridden: true,
    };
  }
}

/** A passagem ativa do processo travado (a de `currentStageId`). */
function activePassOf(rows: ProcessAggregateRows, process: Process): ProcessStageRow {
  const active = rows.stages.find(
    (stage) => stage.id === process.currentStageId && stage.status === 'ACTIVE',
  );
  if (active === undefined) throw returnTargetNotAvailable();
  return active;
}
