import { withSpan } from '@contrataflow/observability';
import {
  MOVEMENT_METADATA_VERSION,
  PROCESS_COMPLETION_MESSAGES,
  ProcessStageChanged,
  ProcessStatusChanged,
  movementMetadataSchema,
} from '@contrataflow/validation';
import type {
  ChecklistViolation,
  CompletedProcessDto,
  MovementMetadata,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { PROCESS_CLOCK, PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type {
  ProcessAggregateRows,
  ProcessClock,
  ProcessRepository,
  ProcessTransactions,
} from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessCompletionRecorder } from './process-completion.recorder.js';
import { ProcessPanelReader } from './process-panel.queries.js';
import { ProcessLifecycleSupport, actorOf, logConflict } from './process-suspension.commands.js';
import {
  completeNotCustodian,
  completionBlocked,
  completionVersionConflict,
  completionWarningsNotAcknowledged,
  processNotCompletable,
  processNotFoundError,
  transitionNotAvailable,
} from './process.errors.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { StageTransitionService } from './stage-transition.service.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type {
  TransitionEvaluation,
  WorkflowSnapshotStage,
} from '../../workflow/application/workflow.facade.js';
import { canCompleteFrom, planCompletionAtEnd } from '../domain/process-completion.js';
import type { ProcessCompletion } from '../domain/process-completion.js';
import {
  acknowledgedWarningsOf,
  blockingViolations,
  unacknowledgedWarnings,
} from '../domain/process-forward.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import { isProcessCustodian } from '../domain/process-update.js';
import type { Process } from '../domain/process.js';

/*
 * PRC-26 — `CompleteProcessCommand` (US-010 · DEC-013 · DEC-015 · POL-01/POL-08 · RN-PROC-111..117):
 * a conclusão MANUAL do processo. Em UMA transação do tenant: `SELECT … FOR UPDATE` no processo e
 * visibilidade (404) → `If-Match` (412 — a corrida com um encaminhamento perde aqui, antes de a
 * custódia ter mudado) → `PROCESS_COMPLETE` cobrindo o processo (403 `PERMISSION_DENIED`, auditado)
 * → status `IN_PROGRESS` (409 `INVALID_PROCESS_STATUS` — suspenso, devolvido, rascunho…) →
 * custódia (POL-01: 403 `NOT_PROCESS_CUSTODIAN`, auditado) → saída de conclusão pelo motor de
 * workflow (transição `COMPLETE` ou etapa `END` já ativa — 422 `TRANSITION_NOT_AVAILABLE`) →
 * regras `BLOCKING` (422 `TRANSITION_BLOCKED`) e `WARNING` não reconhecidas (422
 * `WARNINGS_NOT_ACKNOWLEDGED`) → mudança de etapa para a `END` pela rotina compartilhada com a
 * conclusão automática (`completeProcess` via `StageTransitionService` — US-052) → auditoria
 * `process.complete` (`cause = MANUAL`). Os eventos `ProcessStageChanged` (`cause COMPLETE`) e
 * `ProcessStatusChanged`/`ProcessCompleted` saem pelo outbox no mesmo `tx` (timeline síncrona);
 * qualquer falha desfaz tudo. Nunca registra o comentário nos logs.
 */

export interface CompleteProcessInput {
  readonly processId: string;
  /** Observação opcional (até 5.000) — `ProcessMovement.comment`. */
  readonly comment: string | null;
  /** Ids das regras `WARNING` reconhecidas no diálogo (RN-PROC-113). */
  readonly acknowledgedWarnings: readonly string[];
  /** `If-Match` (a versão que o painel leu — DEC-104; o 428 é do guard). */
  readonly expectedVersion: number;
  readonly idempotencyKey: string | null;
}

export interface CompletedProcess {
  readonly dto: CompletedProcessDto;
  readonly completion: ProcessCompletion;
}

interface Prepared {
  readonly now: Date;
}

/** O que a conclusão grava, nos dois formatos de saída (transição `COMPLETE` ou etapa `END`). */
interface Applied {
  readonly process: Process;
  readonly completion: ProcessCompletion;
  readonly movementId: string;
}

@Injectable()
export class CompleteProcessCommand extends TransactionalCommandHandler<
  CompleteProcessInput,
  Prepared,
  CompletedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly identity: IdentityFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly lifecycle: ProcessLifecycleSupport,
    private readonly transitions: StageTransitionService,
    private readonly support: StageTransitionSupport,
    private readonly completions: ProcessCompletionRecorder,
  ) {
    super('process.complete', transactions);
  }

  override async execute(input: CompleteProcessInput): Promise<CompletedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      logConflict(this.logger, input.processId, error);
      throw error;
    }
  }

  protected prepare(): Promise<Prepared> {
    return Promise.resolve({ now: this.clock() });
  }

  protected async handle(
    tx: TenantTx,
    input: CompleteProcessInput,
    { now }: Prepared,
  ): Promise<CompletedProcess> {
    // Trava antes de ler: o estado lido é o do vencedor de qualquer corrida (404 = invisível).
    if (!(await this.processes.lockForUpdate(tx, input.processId))) throw processNotFoundError();
    const { rows, runtime, viewer } = await this.panel.load(tx, input.processId);
    const { process } = rows;

    // V-06 — `If-Match` primeiro: quem perdeu a corrida para um encaminhamento recebe 412.
    if (input.expectedVersion !== process.version) {
      throw completionVersionConflict(input.expectedVersion, process.version);
    }
    // V-02/V-03/V-01 — PROCESS_COMPLETE cobrindo o processo, status e custódia (POL-01/POL-08).
    await this.access.assertCanOnProcess(
      'PROCESS_COMPLETE',
      accessTargetOf(runtime),
      PROCESS_COMPLETION_MESSAGES.permissionDenied,
    );
    if (!canCompleteFrom(process.status, 'MANUAL')) throw processNotCompletable(process.status);
    if (!isProcessCustodian(process, viewer.engine)) throw completeNotCustodian();

    // V-04/V-05 — a saída de conclusão e as regras de saída (RN-PROC-113 · DEC-016).
    const choice = await withSpan('process.complete.rules', {}, () =>
      this.workflow.evaluateCompletion(tx, executionStateOf(runtime)),
    );
    if (choice.kind === 'UNAVAILABLE') {
      throw transitionNotAvailable(PROCESS_COMPLETION_MESSAGES.transitionNotAvailable);
    }
    const violations = choice.kind === 'END' ? choice.violations : choice.evaluation.violations;
    if (blockingViolations(violations).length > 0) throw completionBlocked(violations);
    const pending = unacknowledgedWarnings(violations, input.acknowledgedWarnings);
    if (pending.length > 0) throw completionWarningsNotAcknowledged(pending);
    const acknowledged = acknowledgedWarningsOf(violations, input.acknowledgedWarnings);
    this.logAcknowledged(process.id, violations, input.acknowledgedWarnings);

    const applied =
      choice.kind === 'END'
        ? await this.completeAtEnd(tx, rows, runtime, choice.stage, input, acknowledged, now)
        : await this.completeByTransition(tx, rows, choice.evaluation, input, acknowledged, now);

    await this.completions.recordIn(tx, {
      before: process,
      after: applied.process,
      completion: applied.completion,
      movementId: applied.movementId,
      warningsAcknowledged: acknowledged,
      idempotencyKey: input.idempotencyKey,
    });

    const dto = await this.lifecycle.presentProcess(tx, rows, runtime, applied.process);
    const completedById = applied.completion.completedById;
    const name = (await this.identity.userDisplayNames(tx, [completedById])).get(completedById);
    return {
      dto: {
        ...dto,
        completedAt: applied.completion.completedAt.toISOString(),
        completedBy: { id: completedById, name: name ?? '' },
      },
      completion: applied.completion,
    };
  }

  protected override committed(result: CompletedProcess, durationMs: number): void {
    this.completions.committed(result.dto.id, result.completion, durationMs);
  }

  /** Transição `COMPLETE` → etapa `END` pelo `StageTransitionService` (a mesma da US-052). */
  private async completeByTransition(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    evaluation: TransitionEvaluation,
    input: CompleteProcessInput,
    acknowledged: MovementMetadata['warningsAcknowledged'],
    now: Date,
  ): Promise<Applied> {
    const { process } = rows;
    const { transition, fromStage, toStage } = evaluation;
    const active = rows.stages.find(
      (stage) => stage.id === process.currentStageId && stage.status === 'ACTIVE',
    );
    if (active === undefined) throw processNotCompletable(process.status);
    // A etapa `END` não tem fila nem prazo: a unidade resolvida (ou a atual, se escolhida na hora).
    const toDepartmentId =
      this.workflow.resolveStageDepartment(toStage, process).departmentId ??
      process.currentDepartmentId;
    const actor = actorOf();
    const labels = await this.support.labels(tx, {
      fromStage: fromStage.name,
      toStage: toStage.name,
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId,
      fromUserId: process.currentResponsibleId,
      toUserId: null,
    });
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      warningsAcknowledged: acknowledged,
      computedDueAt: null,
      dueDateOverridden: false,
      labels,
      clientChannel: 'WEB',
    });
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
        action: 'COMPLETE',
        closeAs: 'COMPLETED',
        transitionId: transition.id,
        toWorkflowStageId: toStage.id,
        toDepartmentId,
        toUserId: null,
        assignedById: null,
        slaDays: null,
        slaType: toStage.slaType,
        dueAt: null,
        dueDateOverrideReason: null,
        statusTo: 'COMPLETED',
        comment: input.comment,
        documents: [],
        approvalId: null,
        metadata,
        numbering: null,
        completion: 'MANUAL',
        actor,
        now,
        ids: { stage: newId(), assignment: newId(), movement: newId() },
      },
      cause: 'COMPLETE',
      statusCause: 'COMPLETE',
      fromStageKey: fromStage.key,
      toStage: { key: toStage.key, type: toStage.type },
      requestedApprovalId: null,
    });
    // `completion` existe sempre que o plano pede a conclusão (RN-PROC-115).
    if (plan.completion === null) throw new Error('Conclusão ausente no plano da etapa END.');
    return { process: plan.process, completion: plan.completion, movementId: plan.movement.id };
  }

  /** FA-03 — a etapa `END` já ativa: encerra a passagem na própria etapa, sem transição. */
  private async completeAtEnd(
    tx: TenantTx,
    rows: ProcessAggregateRows,
    runtime: ProcessRuntime,
    stage: WorkflowSnapshotStage,
    input: CompleteProcessInput,
    acknowledged: MovementMetadata['warningsAcknowledged'],
    now: Date,
  ): Promise<Applied> {
    const { process } = rows;
    const active = this.lifecycle.activePass(rows);
    if (active === null) throw processNotCompletable(process.status);
    const base = await this.lifecycle.metadata(tx, runtime, process);
    const plan = planCompletionAtEnd({
      process,
      active,
      comment: input.comment,
      lastMovementSequence: await this.lifecycle.lastMovementSequence(tx, process.id),
      metadata: movementMetadataSchema.parse({ ...base, warningsAcknowledged: acknowledged }),
      actor: actorOf(),
      now,
      movementId: newId(),
    });
    if (!(await this.processes.recordCompletionAtEnd(tx, plan))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw completionVersionConflict(input.expectedVersion, process.version + 1);
    }
    const stageRef = { processStageId: active.id, key: stage.key };
    await this.outbox.record(
      tx,
      ProcessStageChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          cause: 'COMPLETE',
          movementId: plan.movement.id,
          fromStage: stageRef,
          toStage: { ...stageRef, type: stage.type },
          fromDepartmentId: process.currentDepartmentId,
          toDepartmentId: process.currentDepartmentId,
          toUserId: process.currentResponsibleId,
          dueAt: null,
          documentIds: [],
          hasComment: input.comment !== null,
          approvalId: null,
        },
      }),
    );
    await this.outbox.record(
      tx,
      ProcessStatusChanged.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          fromStatus: process.status,
          toStatus: 'COMPLETED',
          cause: 'COMPLETE',
          reasonProvided: false,
        },
      }),
    );
    return { process: plan.process, completion: plan.completion, movementId: plan.movement.id };
  }

  /** `warn workflow.exit_rule_warning_acknowledged` por aviso reconhecido (story · Logs). */
  private logAcknowledged(
    processId: string,
    violations: readonly ChecklistViolation[],
    acknowledged: readonly string[],
  ): void {
    const correlationId = requireRequestContext().correlationId;
    for (const violation of violations) {
      if (violation.severity !== 'WARNING') continue;
      if (!acknowledged.includes(violation.ruleId)) continue;
      this.logger.warn(
        {
          event: 'workflow.exit_rule_warning_acknowledged',
          ruleId: violation.ruleId,
          processId,
          correlationId,
        },
        'workflow.exit_rule_warning_acknowledged',
      );
    }
  }
}
