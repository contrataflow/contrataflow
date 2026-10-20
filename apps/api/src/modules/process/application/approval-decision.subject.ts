import { withSpan } from '@contrataflow/observability';
import {
  APPROVAL_DECISION_MESSAGES,
  decisionRequiresComment,
  movementMetadataSchema,
  MOVEMENT_METADATA_VERSION,
  PROCESS_FORWARD_MESSAGES,
} from '@contrataflow/validation';
import type {
  ApprovalDecision,
  ApprovalDecisionOption,
  MovementMetadata,
  ProcessStatus,
  StageChangeCause,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
  AcknowledgedRuleWarning,
  ApprovalSubjectHandler,
  DecisionSubject,
  DecisionSubjectView,
  SubjectDecisionInput,
  SubjectDecisionResult,
} from '#shared/approval/approval-subject.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessAggregateRows, ProcessRepository, ProcessStageRow } from './ports.js';
import { executionStateOf } from './process-actions.queries.js';
import { ProcessCompletionRecorder } from './process-completion.recorder.js';
import { ProcessRuntimeLoader } from './process-runtime.loader.js';
import { processNotCompletable, transitionNotAvailable } from './process.errors.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { StageTransitionService } from './stage-transition.service.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { StageApprover, StageCoverage } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type {
  DecisionEvaluation,
  WorkflowSnapshotStage,
} from '../../workflow/application/workflow.facade.js';
import { canCompleteFrom } from '../domain/process-completion.js';
import {
  acknowledgedWarningsOf,
  blockingViolations,
  coveredDocuments,
  movementDocumentIds,
  movementDocumentRefs,
  statusOnEntering,
  unacknowledgedWarnings,
} from '../domain/process-forward.js';
import { resolvePreviousAssignee, returnDepartmentOf } from '../domain/process-return.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import type { Process } from '../domain/process.js';

/*
 * Dono do sujeito `PROCESS_STAGE` da decisão de aprovação (US-052 · DEC-013/014/015/018 ·
 * RN-TRAM-56..61), no `tx` do comando `approval` e com o processo travado primeiro (ordem de
 * bloqueio processo → aprovação → documentos):
 *
 * - `planDecision` (sem escrita): a saída do workflow pela ação da decisão (`APPROVE`/`RETURN`/
 *   `REJECT` — devolução e indeferimento só para etapa percorrida), as regras `TRANSITION`
 *   (`TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED`), unidade, responsável e prazo do destino, o
 *   status (DEC-013 · RN-TRAM-59) e, no destino `APPROVAL`, o aprovador da próxima aprovação
 *   (`APPROVER_UNRESOLVED` antes de qualquer escrita — RN-TRAM-60);
 * - `applyDecision`: o status de cada documento coberto (DEC-018, selo `APPROVAL_STAMPED`), a
 *   submissão dos cobertos da próxima etapa `APPROVAL`, a mudança de etapa (`StageTransitionService`
 *   — tramitação `APPROVE`/`RETURN`/`REJECT` com a aprovação; destino `END` conclui o processo —
 *   DOM-09), o efeito do tipo de cada documento coberto (US-017 — o DFD propaga valor, PCA,
 *   prioridade e quantidades) e a nova aprovação encadeada (US-051).
 */

const CAUSE_OF: Readonly<Record<ApprovalDecision, StageChangeCause>> = {
  APPROVE: 'APPROVAL_APPROVED',
  RETURN: 'APPROVAL_RETURNED',
  REJECT: 'APPROVAL_REJECTED',
};

const OUTCOME_OF = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
} as const satisfies Record<ApprovalDecision, string>;

/** O plano resolvido sob a trava, antes de qualquer escrita. */
export interface StageDecisionPlan {
  readonly input: SubjectDecisionInput;
  readonly rows: ProcessAggregateRows;
  readonly process: Process;
  readonly active: ProcessStageRow;
  readonly evaluation: DecisionEvaluation;
  readonly acknowledged: readonly AcknowledgedRuleWarning[];
  readonly toDepartmentId: string;
  readonly toUserId: string | null;
  readonly dueAt: Date | null;
  readonly statusTo: ProcessStatus;
  /** Aprovador da próxima etapa `APPROVAL` (encadeamento); `null` nos demais destinos. */
  readonly approver: StageApprover | null;
}

@Injectable()
export class ProcessApprovalSubjectHandler implements ApprovalSubjectHandler<StageDecisionPlan> {
  readonly subjectType = 'PROCESS_STAGE' as const;
  private readonly logger = new Logger('Approval');

  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    private readonly runtimes: ProcessRuntimeLoader,
    private readonly workflow: WorkflowFacade,
    private readonly documents: DocumentFacade,
    private readonly approvals: ApprovalFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly organization: OrganizationFacade,
    private readonly transitions: StageTransitionService,
    private readonly support: StageTransitionSupport,
    private readonly completions: ProcessCompletionRecorder,
  ) {}

  async prepareDecision(
    tx: TenantTx,
    subject: DecisionSubject,
  ): Promise<DecisionSubjectView | null> {
    // 6.1 — o processo primeiro (ordem de bloqueio): o estado lido é o do vencedor da corrida.
    if (!(await this.processes.lockForUpdate(tx, subject.processId))) return null;
    return this.describeSubject(tx, subject);
  }

  async describeSubject(
    tx: TenantTx,
    subject: DecisionSubject,
  ): Promise<DecisionSubjectView | null> {
    const rows = await this.processes.loadAggregate(tx, subject.processId);
    if (rows === null) return null;
    const { process } = rows;
    const coverage = await this.documents.approvalCoverageIn(tx, subject.coverage);
    return {
      processCode: process.code,
      processTitle: process.title,
      processStatus: process.status,
      organizationId: process.organizationId,
      requestingSecretariatId: process.requestingSecretariatId,
      requestingDepartmentId: process.requestingDepartmentId,
      authorIds: coverage.authorIds,
      documents: coverage.documents,
    };
  }

  async decisionOptions(tx: TenantTx, subject: DecisionSubject): Promise<ApprovalDecisionOption[]> {
    const rows = await this.processes.loadAggregate(tx, subject.processId);
    if (rows?.process.currentStageId !== subject.processStageId) return [];
    const runtime = await this.runtimes.fromAggregate(tx, rows);
    const targets = await this.workflow.decisionTargets(tx, executionStateOf(runtime));
    return targets.map(({ transition, toStage, violations }) => {
      const decision = transition.action as ApprovalDecision;
      return {
        decision,
        transitionId: transition.id,
        label: transition.name,
        toStage: { id: toStage.id, key: toStage.key, name: toStage.name, type: toStage.type },
        requiresComment: decisionRequiresComment(decision) || transition.requiresComment,
        enabled: blockingViolations(violations).length === 0,
        violations: [...violations],
      };
    });
  }

  async planDecision(tx: TenantTx, input: SubjectDecisionInput): Promise<StageDecisionPlan> {
    const { subject, decision, now } = input;
    const rows = await this.processes.loadAggregate(tx, subject.processId);
    const active = rows?.stages.find(
      (stage) => stage.id === rows.process.currentStageId && stage.status === 'ACTIVE',
    );
    // A aprovação pendente é da passagem ativa (a pendência única e a trava garantem).
    if (rows === null || active?.id !== subject.processStageId) {
      throw transitionNotAvailable(APPROVAL_DECISION_MESSAGES.transitionNotAvailable);
    }
    const { process } = rows;
    const runtime = await this.runtimes.fromAggregate(tx, rows);

    // 6.3 / 6.6 — a saída pela ação da decisão e as regras TRANSITION (RN-TRAM-56 · DEC-016).
    const choice = await withSpan('approval.decide.rules', {}, () =>
      this.workflow.evaluateDecision(tx, executionStateOf(runtime), {
        action: decision,
        transitionId: input.transitionId,
      }),
    );
    if (choice.kind === 'CHOICE_REQUIRED') {
      throw validationError([
        {
          field: 'transitionId',
          code: 'REQUIRED',
          message: APPROVAL_DECISION_MESSAGES.returnTargetRequired,
        },
      ]);
    }
    if (choice.kind === 'UNAVAILABLE') {
      throw transitionNotAvailable(APPROVAL_DECISION_MESSAGES.transitionNotAvailable);
    }
    const { evaluation } = choice;
    const blocking = blockingViolations(evaluation.violations);
    if (blocking.length > 0) {
      throw new ApiError('TRANSITION_BLOCKED', {
        detail:
          blocking.length === 1
            ? `Não é possível concluir esta decisão agora: ${blocking[0]?.message ?? ''}`
            : APPROVAL_DECISION_MESSAGES.transitionBlocked,
        violations: evaluation.violations,
      });
    }
    const pending = unacknowledgedWarnings(evaluation.violations, input.acknowledgedWarnings);
    if (pending.length > 0) {
      throw new ApiError('WARNINGS_NOT_ACKNOWLEDGED', {
        detail: APPROVAL_DECISION_MESSAGES.warningsNotAcknowledged,
        violations: pending,
      });
    }
    if (evaluation.transition.requiresComment && input.comment === null) {
      throw validationError([
        { field: 'comment', code: 'REQUIRED', message: APPROVAL_DECISION_MESSAGES.commentRequired },
      ]);
    }

    // 6.6 — unidade, responsável (RN-TRAM-61) e prazo (US-055) do destino; status (RN-TRAM-59).
    const { toStage } = evaluation;
    const backward = decision !== 'APPROVE';
    const toDepartmentId = await this.destination(tx, toStage, rows, active);
    const toUserId = backward
      ? await this.previousAssignee(tx, process, toStage.id, toDepartmentId, now)
      : await this.policyAssignee(tx, toStage, runtime, toDepartmentId, now);
    const dueAt =
      toStage.type === 'END' || toStage.slaDays === null
        ? null
        : await this.calendar.addBusinessDays(tx, now, toStage.slaDays, toStage.slaType);
    const statusTo: ProcessStatus = backward
      ? 'RETURNED'
      : toStage.type === 'END'
        ? 'COMPLETED'
        : statusOnEntering(toStage.type);
    // RN-PROC-112/114 (US-010): a conclusão automática só a partir de AWAITING_APPROVAL.
    if (statusTo === 'COMPLETED' && !canCompleteFrom(process.status, 'APPROVAL')) {
      throw processNotCompletable(process.status);
    }

    // 6.9 (preparo) — destino APPROVAL: o aprovador ANTES de qualquer escrita (RN-TRAM-60).
    const approver =
      toStage.type === 'APPROVAL' ? await this.chainedApprover(tx, toStage, process, now) : null;
    return {
      input,
      rows,
      process,
      active,
      evaluation,
      acknowledged: acknowledgedWarningsOf(evaluation.violations, input.acknowledgedWarnings),
      toDepartmentId,
      toUserId,
      dueAt,
      statusTo,
      approver,
    };
  }

  async applyDecision(tx: TenantTx, plan: StageDecisionPlan): Promise<SubjectDecisionResult> {
    const { input, process, active, evaluation } = plan;
    const { subject, decision, now } = input;
    const { transition, fromStage, toStage } = evaluation;
    const context = requireRequestContext();
    const startedAt = performance.now();

    // 6.5 / 6.10 — cada documento coberto (DEC-018) e o selo APPROVAL_STAMPED do aprovado.
    const afterCommit: (() => Promise<void>)[] = [];
    const approvedDocumentIds: string[] = [];
    for (const item of subject.coverage) {
      const outcome = await this.documents.applyApprovalOutcomeIn(tx, {
        documentId: item.documentId,
        approvalId: subject.approvalId,
        outcome: OUTCOME_OF[decision],
        analyzedVersionId: item.documentVersionId,
      });
      if (outcome.document.status === 'APPROVED') approvedDocumentIds.push(outcome.document.id);
      if (outcome.afterCommit !== null) afterCommit.push(outcome.afterCommit);
    }

    // 6.9 — encadeamento: os cobertos da próxima etapa entram na nova aprovação (US-051).
    const chainedApprovalId = plan.approver === null ? null : newId();
    const coverage: StageCoverage[] = [];
    let documents = await this.documents.movementDocumentsIn(tx, process.id);
    if (chainedApprovalId !== null) {
      for (const document of coveredDocuments(documents, toStage.approvalDocumentTypeCodes)) {
        const entry = await this.documents.enterApprovalStageIn(tx, {
          documentId: document.id,
          approvalId: chainedApprovalId,
          acknowledgedWarnings: input.acknowledgedWarnings,
        });
        coverage.push({
          documentId: document.id,
          documentVersionId: entry.documentVersionId,
          documentCode: entry.document.code,
        });
      }
      if (coverage.length > 0) documents = await this.documents.movementDocumentsIn(tx, process.id);
    }

    // 6.6 / 6.7 / 6.8 — passagem, responsabilidade, tramitação e status (StageTransitionService).
    const labels = await this.support.labels(tx, {
      fromStage: fromStage.name,
      toStage: toStage.name,
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: plan.toDepartmentId,
      fromUserId: process.currentResponsibleId,
      toUserId: plan.toUserId,
    });
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      warningsAcknowledged: plan.acknowledged,
      computedDueAt: plan.dueAt?.toISOString() ?? null,
      dueDateOverridden: false,
      ...(chainedApprovalId === null ? {} : { approvalRequestedId: chainedApprovalId }),
      labels,
      clientChannel: 'WEB',
    });
    const backward = decision !== 'APPROVE';
    const transitionPlan = await this.transitions.apply(tx, {
      transition: {
        process,
        active: {
          id: active.id,
          workflowStageId: active.workflowStageId,
          sequence: active.sequence,
          departmentId: active.departmentId,
          assigneeId: active.assigneeId,
        },
        lastStageSequence: Math.max(...plan.rows.stages.map((stage) => stage.sequence)),
        lastMovementSequence: await this.processes.lastMovementSequence(tx, process.id),
        action: decision,
        closeAs: backward ? 'RETURNED' : 'COMPLETED',
        transitionId: transition.id,
        toWorkflowStageId: toStage.id,
        toDepartmentId: plan.toDepartmentId,
        toUserId: plan.toUserId,
        assignedById: null,
        assignmentType: backward ? 'RETURN' : 'STAGE_ENTRY',
        slaDays: toStage.type === 'END' ? null : toStage.slaDays,
        slaType: toStage.slaType,
        dueAt: plan.dueAt,
        dueDateOverrideReason: null,
        statusTo: plan.statusTo,
        comment: input.comment,
        documents: movementDocumentRefs(
          movementDocumentIds(
            subject.coverage.map((item) => item.documentId),
            coverage.map((item) => item.documentId),
          ),
          documents,
        ),
        approvalId: subject.approvalId,
        metadata,
        numbering: null,
        // US-010 · RN-PROC-112: destino END conclui pela rotina compartilhada (`completeProcess`).
        ...(plan.statusTo === 'COMPLETED' ? { completion: 'APPROVAL' as const } : {}),
        actor: {
          userId: input.decidedById,
          ip: context.ip,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        },
        now,
        ids: { stage: newId(), assignment: newId(), movement: newId() },
      },
      cause: CAUSE_OF[decision],
      statusCause: 'APPROVAL_DECISION',
      fromStageKey: fromStage.key,
      toStage: { key: toStage.key, type: toStage.type },
      requestedApprovalId: chainedApprovalId,
    });

    // US-017: o efeito do tipo de cada documento coberto (o DFD propaga ao processo), DEPOIS da
    // mudança de etapa — grava sobre a versão que a transição deixou, no mesmo `tx`.
    for (const item of subject.coverage) {
      await this.documents.applyApprovalEffectsIn(tx, {
        documentId: item.documentId,
        approvalId: subject.approvalId,
        outcome: OUTCOME_OF[decision],
        analyzedVersionId: item.documentVersionId,
        decidedById: input.decidedById,
        now,
      });
    }

    // US-010 · RN-PROC-115: `process.complete` (cause APPROVAL, completedById = aprovador).
    const { completion } = transitionPlan;
    if (completion !== null) {
      await this.completions.recordIn(tx, {
        before: process,
        after: transitionPlan.process,
        completion,
        movementId: transitionPlan.movement.id,
        warningsAcknowledged: plan.acknowledged,
        idempotencyKey: null,
      });
      afterCommit.push(() => {
        this.completions.committed(
          process.id,
          completion,
          Math.round(performance.now() - startedAt),
        );
        return Promise.resolve();
      });
    }

    // 6.9 — a próxima aprovação (a passagem já existe: FK).
    if (plan.approver !== null && chainedApprovalId !== null) {
      await this.approvals.requestForStageIn(tx, {
        approvalId: chainedApprovalId,
        processId: process.id,
        processStageId: transitionPlan.entered.id,
        stageName: toStage.name,
        approver: plan.approver,
        coverage,
        requestedById: input.decidedById,
        requestedAt: now,
        requestComment: null,
        dueAt: transitionPlan.entered.dueAt,
      });
      this.logger.log(
        {
          event: 'approval.chained',
          approvalId: subject.approvalId,
          chainedApprovalId,
          processId: process.id,
          nextStageKey: toStage.key,
          approverType: plan.approver.approverType,
          correlationId: context.correlationId,
        },
        'approval.chained',
      );
    }
    return {
      fromStatus: process.status,
      toStatus: transitionPlan.process.status,
      processStage: { key: toStage.key, name: toStage.name },
      warningsAcknowledged: plan.acknowledged,
      movementId: transitionPlan.movement.id,
      chainedApprovalId,
      approvedDocumentIds,
      afterCommit,
    };
  }

  /**
   * RN-TRAM-27 (US-048) aplicada à decisão: a `departmentResolution` do destino;
   * `CHOSEN_ON_FORWARD` (a decisão não coleta unidade) reaproveita a da última passagem pela etapa
   * ou, se nunca percorrida, a de quem encaminhou à aprovação (passagem anterior). Sem unidade
   * resolvível ou unidade inativa = destino indisponível.
   */
  private async destination(
    tx: TenantTx,
    toStage: WorkflowSnapshotStage,
    rows: ProcessAggregateRows,
    active: ProcessStageRow,
  ): Promise<string> {
    const resolved = this.workflow.resolveStageDepartment(toStage, rows.process);
    const lastPass = rows.stages
      .filter((stage) => stage.workflowStageId === toStage.id && stage.status !== 'ACTIVE')
      .reduce<ProcessStageRow | null>(
        (latest, stage) => (latest === null || stage.sequence > latest.sequence ? stage : latest),
        null,
      );
    const previous = rows.stages.find((stage) => stage.sequence === active.sequence - 1);
    const departmentId = returnDepartmentOf(
      toStage.departmentResolution,
      resolved.departmentId,
      lastPass?.departmentId ?? previous?.departmentId ?? rows.process.requestingDepartmentId,
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
   * Devolução e indeferimento (RN-TRAM-61 · "retornam ao custodiante anterior"): o responsável
   * mais recente das passagens encerradas pela etapa, se ainda elegível; senão, a fila da unidade.
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
    if (
      candidate !== null &&
      (await this.support.isEligibleAssignee(tx, candidate, toDepartmentId, now))
    ) {
      return candidate;
    }
    this.logger.warn(
      {
        event: 'approval.previous_assignee_not_found',
        processId: process.id,
        candidateIneligible: candidate !== null,
        correlationId: requireRequestContext().correlationId,
      },
      'approval.previous_assignee_not_found',
    );
    return null;
  }

  /** Aprovação (RN-TRAM-61): a `assignmentPolicy` do destino; inelegível = fila. `END` = ninguém. */
  private async policyAssignee(
    tx: TenantTx,
    toStage: WorkflowSnapshotStage,
    runtime: ProcessRuntime,
    toDepartmentId: string,
    now: Date,
  ): Promise<string | null> {
    if (toStage.type === 'END') return null;
    const head =
      toStage.assignmentPolicy === 'DEPARTMENT_HEAD'
        ? ((await this.organization.departmentReferences(tx, [toDepartmentId])).get(toDepartmentId)
            ?.headUserId ?? null)
        : null;
    const candidate = this.workflow.resolveStageAssignee(toStage, {
      creatorId: runtime.createdById,
      departmentHeadId: head,
      passes: runtime.passes,
    });
    if (candidate === null) return null;
    return (await this.support.isEligibleAssignee(tx, candidate, toDepartmentId, now))
      ? candidate
      : null;
  }

  /** RN-TRAM-60 (V-06): o aprovador da próxima etapa; sem aprovador, a decisão inteira é recusada. */
  private async chainedApprover(
    tx: TenantTx,
    toStage: WorkflowSnapshotStage,
    process: Process,
    now: Date,
  ): Promise<StageApprover> {
    try {
      return await this.approvals.resolveStageApproverIn(tx, toStage, process, now);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'APPROVER_UNRESOLVED') {
        throw new ApiError('APPROVER_UNRESOLVED', {
          detail: APPROVAL_DECISION_MESSAGES.approverUnresolved,
        });
      }
      throw error;
    }
  }
}
