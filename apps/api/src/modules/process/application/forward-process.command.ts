import { withSpan } from '@contrataflow/observability';
import {
  ProcessNumberAssigned,
  dueDateOverrideIssues,
  forwardCommentIssues,
  movementMetadataSchema,
  MOVEMENT_METADATA_VERSION,
  PROCESS_FORWARD_MESSAGES,
} from '@contrataflow/validation';
import type {
  FieldError,
  ForwardProcess,
  ForwardedProcessDto,
  MovementMetadata,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TransactionalCommandHandler } from '#shared/commands/transactional-command.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

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
  assigneeNotEligible,
  departmentRequired,
  dueDateOverrideNotAllowed,
  forwardNotCustodian,
  forwardVersionConflict,
  processNotForwardable,
  processNotFoundError,
  recordProcessForwarded,
  stageChanged,
  transitionBlocked,
  transitionNotAvailable,
  warningsNotAcknowledged,
} from './process.errors.js';
import { ProcessPresenter } from './process.presenter.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { StageTransitionService } from './stage-transition.service.js';
import { accessTargetOf } from './update-process.command.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { StageApprover, StageCoverage } from '../../approval/application/approval.facade.js';
import { BusinessCalendarFacade } from '../../catalog/application/business-calendar.facade.js';
import { NumberingFacade } from '../../catalog/application/numbering.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { OrganizationFacade } from '../../organization/application/organization.facade.js';
import { TenancyFacade } from '../../tenancy/application/tenancy.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type {
  TransitionEvaluation,
  WorkflowSnapshotStage,
} from '../../workflow/application/workflow.facade.js';
import {
  acknowledgedWarningsOf,
  blockingViolations,
  canForwardInStatus,
  changedDuringPass,
  chosenDepartmentIssue,
  coveredDocuments,
  destinationDecision,
  movementDocumentIds,
  movementDocumentRefs,
  statusOnEntering,
  unacknowledgedWarnings,
  unknownDocumentIndexes,
} from '../domain/process-forward.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import { isProcessCustodian } from '../domain/process-update.js';
import type { Process, ProcessNumber } from '../domain/process.js';

const ASSIGN_ON = 'numbering.process.assignOn';
/** Espera pelo bloqueio acima disto: `warn process.lock_wait` (story · Logs). */
export const FORWARD_LOCK_WAIT_WARN_MS = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface ForwardProcessInput {
  readonly processId: string;
  readonly body: ForwardProcess;
  /** `If-Match` (a versão que o painel leu — RN-TRAM-03; o 428 é do guard). */
  readonly expectedVersion: number;
  /** `Idempotency-Key` da requisição (auditoria `process.forward`). */
  readonly idempotencyKey: string | null;
}

export interface ForwardedProcess {
  readonly dto: ForwardedProcessDto;
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly toStageType: string;
  readonly transitionKey: string;
  readonly lockWaitMs: number;
}

interface Prepared {
  readonly now: Date;
}

/** Prazo da nova passagem (RN-TRAM-09/10). */
interface ForwardDueDate {
  readonly dueAt: Date | null;
  readonly computedDueAt: Date | null;
  /** Motivo da sobrescrita (`null` = prazo calculado). */
  readonly reason: string | null;
}

/**
 * `ForwardProcessCommand` — PRC-19 (US-047 · fluxo principal, passo 11): o padrão
 * `TransactionalCommandHandler` com o `StageTransitionService`. Em UMA transação do tenant:
 * `SELECT … FOR UPDATE` no processo e visibilidade (404) → etapa esperada (409 `STAGE_CHANGED`)
 * ANTES do `If-Match` (412) → `PROCESS_FORWARD` cobrindo o processo, status e custódia (POL-01) →
 * motor de workflow sobre o estado travado (`TRANSITION_NOT_AVAILABLE`, `TRANSITION_BLOCKED`,
 * `WARNINGS_NOT_ACKNOWLEDGED`) → comentário, unidade e responsável de destino (RN-TRAM-07/08) →
 * prazo (RN-TRAM-09/10) → documentos (RN-TRAM-12) → no destino `APPROVAL`, aprovador e submissão
 * dos documentos cobertos (US-051 · DEC-018) → número na autuação (RN-TRAM-18, por último antes
 * das gravações) → mudança de etapa (passagem, responsabilidade, tramitação, processo) →
 * `Approval` → `process.forward` e eventos (timeline e `ProcessAccess` no mesmo `tx`). Qualquer
 * falha desfaz tudo (RN-TRAM-21). Nenhum valor estimado entra em payload ou log (RN-TRAM-22).
 */
@Injectable()
export class ForwardProcessCommand extends TransactionalCommandHandler<
  ForwardProcessInput,
  Prepared,
  ForwardedProcess
> {
  constructor(
    @Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(PROCESS_CLOCK) private readonly clock: ProcessClock,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly access: AccessFacade,
    private readonly approvals: ApprovalFacade,
    private readonly calendar: BusinessCalendarFacade,
    private readonly numbering: NumberingFacade,
    private readonly documents: DocumentFacade,
    private readonly organization: OrganizationFacade,
    private readonly tenancy: TenancyFacade,
    private readonly workflow: WorkflowFacade,
    private readonly panel: ProcessPanelReader,
    private readonly presenter: ProcessPresenter,
    private readonly transitions: StageTransitionService,
    private readonly support: StageTransitionSupport,
  ) {
    super('process.forward', transactions);
  }

  override async execute(input: ForwardProcessInput): Promise<ForwardedProcess> {
    try {
      return await super.execute(input);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // Recusa de regra (4xx): o código e a quantidade de violações — nunca o conteúdo.
        this.logger.log(
          {
            event: 'process.forward_rejected',
            processId: input.processId,
            code: error.code,
            violations: error.violations.length,
            correlationId: requireRequestContext().correlationId,
          },
          'process.forward_rejected',
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
    input: ForwardProcessInput,
    { now }: Prepared,
  ): Promise<ForwardedProcess> {
    const context = requireRequestContext();
    const userId = context.actor.userId ?? '';
    const { body } = input;

    // 11.2 — trava o processo antes de ler: o estado lido é o do vencedor de qualquer corrida.
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

    // 11.3 — etapa esperada ANTES do If-Match (RN-TRAM-03 · FA-08).
    if (process.currentStageId !== body.expectedStageId) {
      throw stageChanged(process.currentStageId, await this.support.lastWriter(tx, process));
    }
    if (input.expectedVersion !== process.version) {
      throw forwardVersionConflict(input.expectedVersion, process.version);
    }

    // 11.4 — PROCESS_FORWARD cobrindo o processo, status e custódia (RN-TRAM-01/02 · POL-01).
    await this.access.assertCanOnProcess('PROCESS_FORWARD', accessTargetOf(runtime));
    if (!canForwardInStatus(process.status)) throw processNotForwardable(process.status);
    if (!isProcessCustodian(process, viewer.engine)) throw forwardNotCustodian();
    const active = activePassOf(rows, process);

    // 11.5 — motor de workflow sobre o estado travado (RN-TRAM-04/05/06).
    const evaluation = await withSpan('process.forward.rules', {}, () =>
      this.workflow.evaluateTransition(tx, executionStateOf(runtime), {
        transitionId: body.transitionId,
        action: 'FORWARD',
      }),
    );
    if (evaluation === null) throw transitionNotAvailable();
    const blocking = blockingViolations(evaluation.violations);
    if (blocking.length > 0) throw transitionBlocked(evaluation.violations, blocking.length);
    const acknowledged = body.acknowledgedWarnings ?? [];
    const pending = unacknowledgedWarnings(evaluation.violations, acknowledged);
    if (pending.length > 0) throw warningsNotAcknowledged(pending);
    const { transition, fromStage, toStage } = evaluation;
    const toApproval = toStage.type === 'APPROVAL';

    // RN-TRAM-11 (comentário) e RN-TRAM-08 (sem atribuição direta em destino APPROVAL).
    const comment = body.comment === undefined || body.comment === '' ? null : body.comment;
    const issues: FieldError[] = forwardCommentIssues(comment, transition.requiresComment).map(
      (issue) => ({ ...issue }),
    );
    if (toApproval && body.toUserId !== undefined) {
      issues.push({
        field: 'toUserId',
        code: 'NOT_ALLOWED',
        message: PROCESS_FORWARD_MESSAGES.assigneeNotAllowed,
      });
    }
    if (issues.length > 0) throw validationError(issues);

    // 11.6 — unidade e responsável de destino.
    const toDepartmentId = await this.destination(tx, toStage, process, body.toDepartmentId);
    const toUserId = await this.assignee(tx, toStage, runtime, toDepartmentId, body.toUserId, now);

    // 11.7 — prazo calculado (dias úteis/corridos) ou sobrescrito.
    const due = await this.dueDate(tx, evaluation, body, now);

    // RN-TRAM-12 — documentos que acompanham a tramitação.
    const before = await this.documents.movementDocumentsIn(tx, process.id);
    if (body.documentIds !== undefined) {
      const unknown = unknownDocumentIndexes(body.documentIds, before);
      if (unknown.length > 0) {
        throw validationError(
          unknown.map((index) => ({
            field: `documentIds[${String(index)}]`,
            code: 'REFERENCE_NOT_FOUND' as const,
            message: PROCESS_FORWARD_MESSAGES.documentUnavailable,
          })),
        );
      }
    }
    const chosen = body.documentIds ?? changedDuringPass(before, active.enteredAt);

    // 11.13 (preparo) — destino APPROVAL: aprovador ANTES de qualquer escrita; os documentos
    // cobertos são validados e submetidos (DRAFT/RETURNED → IN_REVIEW com versão SUBMISSION).
    const approvalId = toApproval ? newId() : null;
    const approver: StageApprover | null = toApproval
      ? await withSpan('process.forward.approval', {}, () =>
          this.approvals.resolveStageApproverIn(tx, toStage, process),
        )
      : null;
    const covered = toApproval ? coveredDocuments(before, toStage.approvalDocumentTypeCodes) : [];
    const coverage: StageCoverage[] = [];
    for (const document of covered) {
      const entry = await this.documents.enterApprovalStageIn(tx, {
        documentId: document.id,
        approvalId: approvalId ?? '',
      });
      coverage.push({
        documentId: document.id,
        documentVersionId: entry.documentVersionId,
        documentCode: entry.document.code,
      });
    }
    const after =
      covered.length === 0 ? before : await this.documents.movementDocumentsIn(tx, process.id);
    const documents = movementDocumentRefs(
      movementDocumentIds(
        chosen,
        covered.map((document) => document.id),
      ),
      after,
    );

    // 11.9 — autuação no 1º encaminhamento (por último: a sequência fica travada só pelas gravações).
    const labels = await this.support.labels(tx, {
      fromStage: fromStage.name,
      toStage: toStage.name,
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId,
      fromUserId: process.currentResponsibleId,
      toUserId,
    });
    const numbering = await this.autuacao(tx, process);

    // 11.8/11.10–11.12 — mudança de etapa (passagem, responsabilidade, tramitação e processo).
    const metadata: MovementMetadata = movementMetadataSchema.parse({
      v: MOVEMENT_METADATA_VERSION,
      warningsAcknowledged: acknowledgedWarningsOf(evaluation.violations, acknowledged),
      computedDueAt: due.computedDueAt?.toISOString() ?? null,
      dueDateOverridden: due.reason !== null,
      ...(due.reason === null ? {} : { dueDateOverrideReason: due.reason }),
      ...(approvalId === null ? {} : { approvalRequestedId: approvalId }),
      labels,
      clientChannel: 'WEB',
    });
    const statusTo = statusOnEntering(toStage.type);
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
        action: 'FORWARD',
        closeAs: 'COMPLETED',
        transitionId: transition.id,
        toWorkflowStageId: toStage.id,
        toDepartmentId,
        toUserId,
        assignedById: body.toUserId === undefined ? null : userId,
        slaDays: toStage.slaDays,
        slaType: toStage.slaType,
        dueAt: due.dueAt,
        dueDateOverrideReason: due.reason,
        statusTo,
        comment,
        documents,
        approvalId: null,
        metadata,
        numbering,
        actor: {
          userId,
          ip: context.ip,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        },
        now,
        ids: { stage: newId(), assignment: newId(), movement: newId() },
      },
      cause: 'FORWARD',
      statusCause: 'FORWARD',
      fromStageKey: fromStage.key,
      toStage: { key: toStage.key, type: toStage.type },
      requestedApprovalId: approvalId,
    });

    // 11.13 — aprovação da etapa (a passagem já existe: FK).
    if (approver !== null && approvalId !== null) {
      await this.approvals.requestForStageIn(tx, {
        approvalId,
        processId: process.id,
        processStageId: plan.entered.id,
        stageName: toStage.name,
        approver,
        coverage,
        requestedById: userId,
        requestedAt: now,
        requestComment: comment,
        dueAt: plan.entered.dueAt,
      });
    }

    // 11.14 — auditoria e eventos (a timeline e o ProcessAccess já vieram com o ProcessStageChanged).
    if (numbering !== null) await this.recordNumbering(tx, process.id, numbering);
    const updated = plan.process;
    await this.audit.record(tx, {
      action: 'process.forward',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'status', old: process.status, new: updated.status },
        { path: 'currentStageId', old: process.currentStageId, new: updated.currentStageId },
        {
          path: 'currentDepartmentId',
          old: process.currentDepartmentId,
          new: updated.currentDepartmentId,
        },
        {
          path: 'currentResponsibleId',
          old: process.currentResponsibleId,
          new: updated.currentResponsibleId,
        },
        {
          path: 'currentStageDueAt',
          old: process.currentStageDueAt?.toISOString() ?? null,
          new: updated.currentStageDueAt?.toISOString() ?? null,
        },
      ],
      metadata: {
        processCode: updated.code,
        movementId: plan.movement.id,
        transitionKey: transition.key,
        fromStatus: process.status,
        toStatus: updated.status,
        warningsAcknowledged: metadata.warningsAcknowledged ?? [],
        dueDateOverridden: due.reason !== null,
        approvalRequestedId: approvalId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // POL-09 sobre o NOVO estado (quem encaminhou pode ter perdido a custódia).
    const canSeeBudget = await this.panel.canSeeBudget({ ...rows, process: updated }, runtime);
    const dto = await this.presenter.present(tx, updated, canSeeBudget);
    return {
      dto: {
        ...dto,
        movement: { id: plan.movement.id, sequence: plan.movement.sequence },
        ...(approver === null || approvalId === null
          ? {}
          : { approval: { id: approvalId, approverLabel: approver.label } }),
        numberAssigned: numbering !== null,
        statusFrom: process.status,
      },
      fromStageKey: fromStage.key,
      toStageKey: toStage.key,
      toStageType: toStage.type,
      transitionKey: transition.key,
      lockWaitMs,
    };
  }

  protected override committed(result: ForwardedProcess, durationMs: number): void {
    const context = requireRequestContext();
    recordProcessForwarded(result.toStageType, durationMs);
    // Nunca logar comentário, conteúdo de documentos, valores nem IP (story · Logs).
    this.logger.log(
      {
        event: 'process.forwarded',
        processId: result.dto.id,
        movementId: result.dto.movement.id,
        fromStageKey: result.fromStageKey,
        toStageKey: result.toStageKey,
        transitionKey: result.transitionKey,
        toDepartmentId: result.dto.currentDepartment.id,
        hasAssignee: result.dto.currentResponsible !== null,
        durationMs,
        lockWaitMs: result.lockWaitMs,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        correlationId: context.correlationId,
      },
      'process.forwarded',
    );
  }

  /**
   * RN-TRAM-07 (V-10/V-11 · FA-02): unidade pela `departmentResolution` da etapa destino;
   * `CHOSEN_ON_FORWARD` exige unidade ativa do órgão do processo (outro tenant = inexistente).
   */
  private async destination(
    tx: TenantTx,
    toStage: WorkflowSnapshotStage,
    process: Process,
    chosen: string | undefined,
  ): Promise<string> {
    const chosenId = chosen ?? null;
    const resolved = this.workflow.resolveStageDepartment(toStage, process, chosenId);
    const decision = destinationDecision(
      toStage.departmentResolution,
      toStage.departmentResolution === 'CHOSEN_ON_FORWARD' ? null : resolved.departmentId,
      chosenId,
    );
    switch (decision.kind) {
      case 'REQUIRED':
        throw departmentRequired();
      case 'UNRESOLVED':
        throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
      case 'MISMATCH':
        throw validationError([
          {
            field: 'toDepartmentId',
            code: 'NOT_ALLOWED',
            message: PROCESS_FORWARD_MESSAGES.departmentMismatch,
          },
        ]);
      case 'RESOLVED':
        break;
    }
    const reference =
      (await this.organization.departmentReferences(tx, [decision.departmentId])).get(
        decision.departmentId,
      ) ?? null;
    if (toStage.departmentResolution === 'CHOSEN_ON_FORWARD') {
      const issue = chosenDepartmentIssue(reference, process.organizationId);
      if (issue !== null) {
        throw validationError([
          {
            field: 'toDepartmentId',
            code: issue,
            message: PROCESS_FORWARD_MESSAGES.departmentInvalid,
          },
        ]);
      }
    } else if (reference?.isActive !== true) {
      // Lacuna 3 da story: unidade configurada inativa → caminho indisponível, com o motivo.
      throw transitionNotAvailable(PROCESS_FORWARD_MESSAGES.destinationInactive);
    }
    return decision.departmentId;
  }

  /**
   * RN-TRAM-08 (V-12 · FA-03/FA-10): `toUserId` elegível ou 422; sem ele, a `assignmentPolicy` —
   * candidato inelegível vai para a fila da unidade, sem erro.
   */
  private async assignee(
    tx: TenantTx,
    toStage: WorkflowSnapshotStage,
    runtime: ProcessRuntime,
    toDepartmentId: string,
    requested: string | undefined,
    now: Date,
  ): Promise<string | null> {
    if (requested !== undefined) {
      if (!(await this.support.isEligibleAssignee(tx, requested, toDepartmentId, now))) {
        throw assigneeNotEligible();
      }
      return requested;
    }
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

  /**
   * RN-TRAM-09/10 (V-13/V-14 · FA-04): com SLA, o fim do N-ésimo dia útil (ou corrido) depois da
   * entrada; a sobrescrita só com `allowDueDateOverride`, entre hoje e hoje + 365, ao fim do dia.
   */
  private async dueDate(
    tx: TenantTx,
    { transition, toStage }: TransitionEvaluation,
    body: ForwardProcess,
    now: Date,
  ): Promise<ForwardDueDate> {
    const computed =
      toStage.slaDays === null
        ? null
        : await this.calendar.addBusinessDays(tx, now, toStage.slaDays, toStage.slaType);
    if (body.dueAt === undefined) return { dueAt: computed, computedDueAt: computed, reason: null };
    if (!transition.allowDueDateOverride) throw dueDateOverrideNotAllowed();
    const date = DATE_ONLY.test(body.dueAt)
      ? body.dueAt
      : await this.calendar.localDate(tx, new Date(body.dueAt));
    const issues = dueDateOverrideIssues(date, await this.calendar.localDate(tx, now));
    if (issues.length > 0) throw validationError(issues.map((issue) => ({ ...issue })));
    return {
      dueAt: await this.calendar.endOfLocalDay(tx, date),
      computedDueAt: computed,
      reason: body.dueDateOverrideReason ?? '',
    };
  }

  /** RN-TRAM-18 (DEC-028 · FA-07): sem número e com `assignOn = START`, autua agora. */
  private async autuacao(tx: TenantTx, process: Process): Promise<ProcessNumber | null> {
    if (process.number !== null) return null;
    const settings = await this.tenancy.settingValues(tx, [ASSIGN_ON]);
    if (settings.get(ASSIGN_ON) !== 'START') return null;
    const assigned = await withSpan('process.forward.numbering', {}, () =>
      this.numbering.assignProcessNumber(tx, { organizationId: process.organizationId }),
    );
    return { number: assigned.number, year: assigned.year, code: assigned.code };
  }

  /** `process.number_assign` e `ProcessNumberAssigned` (timeline `PROCESS_NUMBER_ASSIGNED`). */
  private async recordNumbering(
    tx: TenantTx,
    processId: string,
    numbering: ProcessNumber,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: 'process.number_assign',
      entityType: 'Process',
      entityId: processId,
      processId,
      changes: [
        { path: 'number', old: null, new: numbering.number },
        { path: 'year', old: null, new: numbering.year },
        { path: 'code', old: null, new: numbering.code },
      ],
      metadata: { number: numbering.number, year: numbering.year, code: numbering.code },
    });
    await this.outbox.record(
      tx,
      ProcessNumberAssigned.of({
        aggregateId: processId,
        processId,
        payload: { number: numbering.number, year: numbering.year, code: numbering.code },
      }),
    );
  }
}

/** A passagem ativa do processo travado (a de `currentStageId`). */
function activePassOf(rows: ProcessAggregateRows, process: Process): ProcessStageRow {
  const active = rows.stages.find(
    (stage) => stage.id === process.currentStageId && stage.status === 'ACTIVE',
  );
  // Sem passagem ativa não há etapa de onde partir (processo concluído/cancelado — status barra antes).
  if (active === undefined) throw transitionNotAvailable();
  return active;
}
