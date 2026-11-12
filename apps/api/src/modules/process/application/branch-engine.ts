import {
  MOVEMENT_METADATA_VERSION,
  PROCESS_BRANCH_MESSAGES,
  ProcessAssigned,
  ProcessBranchArrived,
  ProcessBranchesCanceled,
  ProcessBranchesJoined,
  ProcessBranchesOpened,
  ProcessStageChanged,
  ProcessStatusChanged,
  movementMetadataSchema,
} from '@contrataflow/validation';
import type { ProcessStatus, StageChangeCause, StatusChangeCause } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { executionStateOf } from './execution-state.js';
import { PROCESS_REPOSITORY } from './ports.js';
import type { ProcessAggregateRows, ProcessRepository, ProcessStageRow } from './ports.js';
import {
  forwardVersionConflict,
  stageChanged,
  transitionBlocked,
  transitionNotAvailable,
  warningsNotAcknowledged,
} from './process.errors.js';
import { StageEntryResolver } from './stage-entry.resolver.js';
import type { ResolvedStageEntry } from './stage-entry.resolver.js';
import { StageTransitionSupport } from './stage-transition-support.js';
import { ApprovalFacade } from '../../approval/application/approval.facade.js';
import type { OpenedApproval, StageCoverage } from '../../approval/application/approval.facade.js';
import { DocumentFacade } from '../../document/application/document.facade.js';
import { WorkflowFacade } from '../../workflow/application/workflow.facade.js';
import type {
  WorkflowSnapshot,
  WorkflowSnapshotStage,
} from '../../workflow/application/workflow.facade.js';
import {
  activeStagesOf,
  branchInvariantViolations,
  parallelProcessFields,
} from '../domain/process-branches.js';
import type {
  BranchAwareStage,
  BranchChange,
  BranchOrder,
  ProcessBranchRecord,
  RuntimeChange,
  StageClosure,
  StageEntry,
} from '../domain/process-branches.js';
import {
  blockingViolations,
  coveredDocuments,
  statusOnEntering,
  unacknowledgedWarnings,
} from '../domain/process-forward.js';
import type {
  ProcessAssignmentRecord,
  ProcessMovementRecord,
} from '../domain/process-runtime-records.js';
import type { ProcessRuntime } from '../domain/process-runtime.js';
import type { Process } from '../domain/process.js';
import { planStageTransition, stageEntryOf } from '../domain/stage-transition.js';
import type {
  EnteredPass,
  StageTransitionInput,
  StageTransitionPlan,
} from '../domain/stage-transition.js';

/** O processo real (não focado) de uma ação por etapa (US-124 · RN-WF2-17/18). */
export interface BranchScope {
  /** Processo, passagens e ramos lidos sob a trava do processo. */
  readonly rows: ProcessAggregateRows;
  /** O runtime real (regras da junção e candidatos a responsável). */
  readonly runtime: ProcessRuntime;
  /** A etapa-alvo da ação. */
  readonly target: ProcessStageRow;
}

/** O que a operação fez com os ramos (para a resposta, a auditoria e o log de quem chamou). */
export type BranchOutcome =
  | {
      readonly kind: 'OPENED';
      readonly splitProcessStageId: string;
      readonly branches: readonly { readonly branchKey: string; readonly processStageId: string }[];
      readonly openedApprovals: readonly OpenedApproval[];
    }
  | { readonly kind: 'ADVANCED'; readonly branchKey: string; readonly splitProcessStageId: string }
  | {
      readonly kind: 'ARRIVED';
      readonly branchKey: string;
      readonly splitProcessStageId: string;
      readonly openBranchesLeft: number;
    }
  | {
      readonly kind: 'JOINED';
      readonly branchKey: string;
      readonly splitProcessStageId: string;
      readonly joinProcessStageId: string;
      readonly openedApproval: OpenedApproval | null;
    }
  | {
      readonly kind: 'CANCELED';
      readonly branchKey: string;
      readonly splitProcessStageId: string;
      readonly canceledBranchKeys: readonly string[];
      readonly canceledApprovalIds: readonly string[];
    };

/** Resultado da mudança de etapa (MVP 1 ou de ramo). */
export interface AppliedTransition extends Omit<StageTransitionPlan, 'entered' | 'assignment'> {
  /** A passagem em que a ação entrou; `null` na chegada de ramo que não fecha a junção. */
  readonly entered: EnteredPass | null;
  readonly assignment: ProcessAssignmentRecord | null;
  readonly branch: BranchOutcome | null;
}

/** Pedido do `StageTransitionService` como o motor de ramos o recebe. */
export interface BranchRequest {
  readonly transition: StageTransitionInput;
  readonly cause: StageChangeCause;
  readonly statusCause: StatusChangeCause;
  readonly fromStageKey: string;
  readonly toStage: {
    readonly key: string;
    readonly type: WorkflowSnapshotStage['type'];
    readonly branchKey?: string | null | undefined;
  };
  readonly requestedApprovalId: string | null;
  readonly scope: BranchScope;
  /** Avisos reconhecidos (regras `WARNING` da junção); ausente = não exigidos (decisão). */
  readonly acknowledgedWarnings?: readonly string[];
}

const byDisplay = (
  left: WorkflowSnapshot['transitions'][number],
  right: WorkflowSnapshot['transitions'][number],
) => left.displayOrder - right.displayOrder || (left.id < right.id ? -1 : 1);

/**
 * `BranchEngine` (US-124 · DEC-194 · ADR-005 · RN-WF2-13..28): as operações do runtime que mexem em
 * ramos, no `tx` de quem chama, com o processo JÁ travado (ordem de travas processo → split → ramo):
 *
 * - `open` — entrada no `PARALLEL_SPLIT`: a passagem do split (sem responsável), um `ProcessBranch`
 *   `OPEN` e a primeira passagem de cada ramo (com responsável, prazo e aprovação resolvidos ANTES
 *   das escritas), UM movimento `FORWARD` (etapa anterior → split);
 * - `withinBranch` — encaminhar/devolver dentro do ramo: só a etapa-alvo fecha; a nova herda
 *   `branchKey`/`splitProcessStageId`; os demais ramos não são tocados;
 * - `arrive` — a última etapa do ramo chega ao `PARALLEL_JOIN`: o ramo vira `ARRIVED`; sendo o último
 *   `OPEN`, a junção acontece NA MESMA transação (regras do join sobre o processo inteiro, passagem
 *   do join já `COMPLETED`, split `COMPLETED`, etapa de saída aberta);
 * - `leave` — devolução (ou decisão) para antes da ramificação: cancela os ramos `OPEN`, as etapas
 *   ativas deles e as aprovações pendentes, marca o split `RETURNED` e reabre a etapa de destino.
 *
 * Cada operação grava tudo de uma vez (`applyRuntimeChange` — RN-WF2-28), publica os eventos (a
 * timeline e o `ProcessAccess` vêm no mesmo `tx`) e confere as invariantes do bloco.
 */
@Injectable()
export class BranchEngine {
  private readonly logger = new Logger('BranchEngine');

  constructor(
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly workflow: WorkflowFacade,
    private readonly entries: StageEntryResolver,
    private readonly approvals: ApprovalFacade,
    private readonly documents: DocumentFacade,
    private readonly support: StageTransitionSupport,
  ) {}

  /* ── Entrada no split (RN-WF2-13) ─────────────────────────────────────────────────────────── */

  async open(tx: TenantTx, request: BranchRequest): Promise<AppliedTransition> {
    const input = request.transition;
    const { now } = input;
    const process = request.scope.rows.process;
    const definition = await this.definitionOf(tx, process.workflowVersionId);
    const split = stageOf(definition, input.toWorkflowStageId);
    const outgoing = definition.transitions
      .filter(
        (transition) => transition.fromStageId === split.id && transition.action === 'FORWARD',
      )
      .sort(byDisplay);
    if (outgoing.length === 0) throw transitionNotAvailable();
    // Destino de cada ramo resolvido ANTES de qualquer escrita (FA-04: nada muda numa recusa).
    const resolved: ResolvedStageEntry[] = [];
    for (const transition of outgoing) {
      resolved.push(
        await this.entries.resolve(tx, {
          stage: stageOf(definition, transition.toStageId),
          process,
          runtime: request.scope.runtime,
          now,
        }),
      );
    }
    const [first] = resolved;
    if (first === undefined) throw transitionNotAvailable();
    const labels = await this.support.labels(tx, {
      fromStage: stageOf(definition, input.active.workflowStageId).name,
      toStage: split.name,
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: first.departmentId,
      fromUserId: process.currentResponsibleId,
      toUserId: null,
    });

    // A passagem do split e o movimento único (etapa anterior → split) pelo plano do MVP 1.
    const plan = planStageTransition({
      ...input,
      toDepartmentId: first.departmentId,
      toUserId: null,
      assignedById: null,
      slaDays: null,
      dueAt: null,
      dueDateOverrideReason: null,
      toStageType: 'PARALLEL_SPLIT',
      branchKey: null,
      splitProcessStageId: null,
      metadata: {
        ...input.metadata,
        labels: { ...labels, branches: resolved.map((entry) => entry.stage.name) },
      },
    });
    const splitId = plan.entered.id;
    const movementId = plan.movement.id;
    let sequence = plan.entered.sequence;
    const branchEntries: StageEntry[] = resolved.map((entry) => {
      sequence += 1;
      return {
        id: newId(),
        tenantId: process.tenantId,
        processId: process.id,
        workflowStageId: entry.stage.id,
        sequence,
        departmentId: entry.departmentId,
        assigneeId: entry.assigneeId,
        enteredAt: now,
        dueAt: entry.dueAt,
        slaDays: entry.stage.slaDays,
        slaType: entry.stage.slaDays === null ? null : entry.stage.slaType,
        dueDateOverridden: false,
        dueDateOverrideReason: null,
        enteredViaMovementId: movementId,
        stageType: entry.stage.type,
        branchKey: entry.stage.branchKey ?? entry.stage.key,
        splitProcessStageId: splitId,
        finishedAt: null,
      };
    });
    const order: BranchOrder = new Map(
      branchEntries.map((entry, index) => [entry.branchKey ?? '', index]),
    );
    const fields = parallelProcessFields(
      plan.process,
      branchEntries.map((entry) => awareOf(entry, false)),
      order,
    );
    const after: Process = {
      ...plan.process,
      ...fields,
      currentStageId: splitId,
      currentWorkflowStageId: split.id,
    };
    const branches: ProcessBranchRecord[] = branchEntries.map((entry) => ({
      id: newId(),
      tenantId: process.tenantId,
      processId: process.id,
      splitProcessStageId: splitId,
      branchKey: entry.branchKey ?? '',
      status: 'OPEN',
      arrivedAt: null,
      canceledAt: null,
      cancellationReason: null,
      createdAt: now,
    }));
    const assignments = branchEntries.map((entry) => entryAssignment(entry, 'STAGE_ENTRY'));
    const movement = { ...plan.movement, statusTo: after.status, toUserId: null, branchKey: null };
    await this.write(tx, {
      process: after,
      expectedVersion: plan.expectedVersion,
      completion: null,
      closeStages: [plan.closed],
      insertStages: [stageEntryOf(plan.entered), ...branchEntries],
      insertAssignments: assignments,
      insertBranches: branches,
      updateBranches: [],
      movements: [movement],
    });

    // Aprovação das primeiras etapas `APPROVAL` dos ramos (a passagem já existe: FK).
    const openedApprovals: OpenedApproval[] = [];
    for (const [index, entry] of resolved.entries()) {
      const stage = branchEntries[index];
      if (entry.approvalPlan === null || stage === undefined) continue;
      openedApprovals.push(
        await this.approvals.requestForStageIn(tx, {
          approvalId: newId(),
          processId: process.id,
          processStageId: stage.id,
          stageName: entry.stage.name,
          plan: entry.approvalPlan,
          coverage: [],
          authorIds: () => Promise.resolve([]),
          requestedById: input.actor.userId,
          requestedAt: now,
          requestComment: input.comment,
          dueAt: stage.dueAt,
        }),
      );
    }

    await this.stageChanged(tx, {
      cause: request.cause,
      movementId,
      process: after,
      from: { processStageId: plan.closed.id, key: request.fromStageKey },
      to: { processStageId: splitId, key: split.key, type: split.type },
      fromDepartmentId: process.currentDepartmentId,
      toDepartmentId: first.departmentId,
      toUserId: null,
      dueAt: after.currentStageDueAt,
      documentIds: movement.documents.map((document) => document.documentId),
      hasComment: movement.comment !== null,
      approvalId: null,
      branchKey: null,
      splitProcessStageId: null,
      actives: branchEntries,
    });
    await this.statusChanged(tx, process, after, request.statusCause);
    await this.outbox.record(
      tx,
      ProcessBranchesOpened.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          movementId,
          splitProcessStageId: splitId,
          splitStageKey: split.key,
          branches: branchEntries.map((entry, index) => ({
            branchKey: entry.branchKey ?? '',
            processStageId: entry.id,
            stageKey: resolved[index]?.stage.key ?? '',
            departmentId: entry.departmentId,
            toUserId: entry.assigneeId,
            dueAt: entry.dueAt?.toISOString() ?? null,
          })),
        },
      }),
    );
    for (const entry of branchEntries) {
      if (entry.assigneeId === null) continue;
      await this.outbox.record(
        tx,
        ProcessAssigned.of({
          aggregateId: process.id,
          processId: process.id,
          payload: {
            processStageId: entry.id,
            departmentId: entry.departmentId,
            fromUserId: null,
            toUserId: entry.assigneeId,
            assignmentType: 'STAGE_ENTRY',
            hasReason: false,
          },
        }),
      );
    }
    await this.audit.record(tx, {
      action: 'process.branch_open',
      entityType: 'Process',
      entityId: process.id,
      processId: process.id,
      changes: [
        { path: 'currentStageId', old: process.currentStageId, new: splitId },
        { path: 'activeStagesCount', old: process.activeStagesCount ?? 1, new: branches.length },
      ],
      metadata: {
        movementId,
        splitStageKey: split.key,
        branches: branchEntries.map((entry) => ({
          branchKey: entry.branchKey,
          departmentId: entry.departmentId,
          toUserId: entry.assigneeId,
        })),
      },
    });
    this.logger.log(
      {
        event: 'process.branches_opened',
        processId: process.id,
        splitStageKey: split.key,
        branches: branches.map((branch) => branch.branchKey),
        correlationId: input.actor.correlationId,
      },
      'process.branches_opened',
    );
    return {
      process: after,
      expectedVersion: plan.expectedVersion,
      closed: plan.closed,
      entered: plan.entered,
      assignment: null,
      movement,
      completion: null,
      branch: {
        kind: 'OPENED',
        splitProcessStageId: splitId,
        branches: branchEntries.map((entry) => ({
          branchKey: entry.branchKey ?? '',
          processStageId: entry.id,
        })),
        openedApprovals,
      },
    };
  }

  /* ── Dentro do ramo (RN-WF2-19 · RN-WF2-22) ───────────────────────────────────────────────── */

  async withinBranch(tx: TenantTx, request: BranchRequest): Promise<AppliedTransition> {
    const { scope } = request;
    const { target } = scope;
    const real = scope.rows.process;
    const splitId = target.splitProcessStageId ?? '';
    const branchKey = target.branchKey ?? '';
    const plan = planStageTransition({
      ...request.transition,
      branchKey,
      splitProcessStageId: splitId,
    });
    const actives = [
      ...activeStagesOf(scope.rows.stages).filter((stage) => stage.id !== target.id),
      awareOf(stageEntryOf(plan.entered), plan.movement.action === 'RETURN'),
    ];
    const after: Process = {
      ...plan.process,
      ...parallelProcessFields(real, actives, await this.orderOf(tx, real, scope.rows, splitId)),
      currentStageId: real.currentStageId,
      currentWorkflowStageId: real.currentWorkflowStageId,
    };
    const movement = {
      ...plan.movement,
      statusFrom: real.status,
      statusTo: after.status,
      branchKey,
    };
    await this.write(tx, {
      process: after,
      expectedVersion: plan.expectedVersion,
      completion: null,
      closeStages: [plan.closed],
      insertStages: [stageEntryOf(plan.entered)],
      insertAssignments: [plan.assignment],
      insertBranches: [],
      updateBranches: [],
      movements: [movement],
    });
    await this.stageChanged(tx, {
      cause: request.cause,
      movementId: movement.id,
      process: after,
      from: { processStageId: target.id, key: request.fromStageKey },
      to: { processStageId: plan.entered.id, key: request.toStage.key, type: request.toStage.type },
      fromDepartmentId: target.departmentId,
      toDepartmentId: plan.entered.departmentId,
      toUserId: plan.entered.assigneeId,
      dueAt: plan.entered.dueAt,
      documentIds: movement.documents.map((document) => document.documentId),
      hasComment: movement.comment !== null,
      approvalId: request.requestedApprovalId,
      branchKey,
      splitProcessStageId: splitId,
      actives,
    });
    await this.statusChanged(tx, real, after, request.statusCause);
    await this.assigned(tx, after, plan.entered, target.assigneeId, plan.assignment.type);
    await this.checkInvariants(tx, after);
    return {
      ...plan,
      process: after,
      movement,
      branch: { kind: 'ADVANCED', branchKey, splitProcessStageId: splitId },
    };
  }

  /* ── Chegada à junção e junção (RN-WF2-20/21) ─────────────────────────────────────────────── */

  async arrive(tx: TenantTx, request: BranchRequest): Promise<AppliedTransition> {
    const { scope } = request;
    const { target } = scope;
    const splitId = target.splitProcessStageId ?? '';
    const branchKey = target.branchKey ?? '';
    // RN-WF2-24: processo (já travado) → split → ramo.
    await this.processes.lockStage(tx, splitId);
    const roundBranches = scope.rows.branches.filter(
      (branch) => branch.splitProcessStageId === splitId,
    );
    const branch = roundBranches.find(
      (candidate) => candidate.branchKey === branchKey && candidate.status === 'OPEN',
    );
    if (branch === undefined)
      throw stageChanged(target.id, null, PROCESS_BRANCH_MESSAGES.stageChanged);
    const openOthers = roundBranches.filter(
      (candidate) => candidate.status === 'OPEN' && candidate.id !== branch.id,
    );
    if (openOthers.length > 0) return this.arriveOnly(tx, request, branch, openOthers.length);
    return this.join(tx, request, branch);
  }

  private async arriveOnly(
    tx: TenantTx,
    request: BranchRequest,
    branch: ProcessBranchRecord,
    openBranchesLeft: number,
  ): Promise<AppliedTransition> {
    const { scope } = request;
    const { target } = scope;
    const input = request.transition;
    const { now } = input;
    const real = scope.rows.process;
    const splitId = branch.splitProcessStageId;
    const actives = activeStagesOf(scope.rows.stages).filter((stage) => stage.id !== target.id);
    const after: Process = {
      ...real,
      ...parallelProcessFields(real, actives, await this.orderOf(tx, real, scope.rows, splitId)),
      updatedAt: now,
      updatedById: input.actor.userId,
      version: real.version + 1,
    };
    const movement = this.movement(input, {
      id: input.ids.movement,
      sequence: input.lastMovementSequence + 1,
      action: 'FORWARD',
      transitionId: input.transitionId,
      from: target,
      toProcessStageId: null,
      toWorkflowStageId: input.toWorkflowStageId,
      toDepartmentId: target.departmentId,
      toUserId: null,
      statusFrom: real.status,
      statusTo: after.status,
      branchKey: branch.branchKey,
      splitProcessStageId: splitId,
    });
    const closed: StageClosure = {
      id: target.id,
      status: 'COMPLETED',
      exitedAt: now,
      exitedViaMovementId: movement.id,
    };
    await this.write(tx, {
      process: after,
      expectedVersion: real.version,
      completion: null,
      closeStages: [closed],
      insertStages: [],
      insertAssignments: [],
      insertBranches: [],
      updateBranches: [{ id: branch.id, status: 'ARRIVED', at: now, cancellationReason: null }],
      movements: [movement],
    });
    // RN-WF2-27: a unidade do ramo concluído perde o `CURRENT` se nenhum outro ramo segue nela.
    if (!actives.some((stage) => stage.departmentId === target.departmentId)) {
      await this.processes.retireCurrentAccess(tx, real.id, target.departmentId, now);
    }
    await this.outbox.record(
      tx,
      ProcessBranchArrived.of({
        aggregateId: real.id,
        processId: real.id,
        payload: {
          splitProcessStageId: splitId,
          branchKey: branch.branchKey,
          processStageId: target.id,
          movementId: movement.id,
          openBranchesLeft,
        },
      }),
    );
    await this.statusChanged(tx, real, after, request.statusCause);
    this.logger.log(
      {
        event: 'process.branch_arrived',
        processId: real.id,
        branchKey: branch.branchKey,
        openBranchesLeft,
        correlationId: input.actor.correlationId,
      },
      'process.branch_arrived',
    );
    await this.checkInvariants(tx, after);
    return {
      process: after,
      expectedVersion: real.version,
      closed: {
        id: target.id,
        status: 'COMPLETED',
        exitedAt: now,
        exitedViaMovementId: movement.id,
      },
      entered: null,
      assignment: null,
      movement,
      completion: null,
      branch: {
        kind: 'ARRIVED',
        branchKey: branch.branchKey,
        splitProcessStageId: splitId,
        openBranchesLeft,
      },
    };
  }

  private async join(
    tx: TenantTx,
    request: BranchRequest,
    branch: ProcessBranchRecord,
  ): Promise<AppliedTransition> {
    const startedAt = performance.now();
    const { scope } = request;
    const { target } = scope;
    const input = request.transition;
    const { now } = input;
    const real = scope.rows.process;
    const splitId = branch.splitProcessStageId;
    const split = scope.rows.stages.find((stage) => stage.id === splitId);
    if (split === undefined)
      throw stageChanged(target.id, null, PROCESS_BRANCH_MESSAGES.stageChanged);
    const definition = await this.definitionOf(tx, real.workflowVersionId);
    const joinStage = stageOf(definition, input.toWorkflowStageId);
    const exit = definition.transitions
      .filter(
        (transition) => transition.fromStageId === joinStage.id && transition.action === 'FORWARD',
      )
      .sort(byDisplay)[0];
    if (exit === undefined) throw transitionNotAvailable();
    const nextStage = stageOf(definition, exit.toStageId);
    if (nextStage.type === 'END' || nextStage.type === 'PARALLEL_SPLIT') {
      // Fora do modelo desta entrega (a junção sai para etapa de trabalho ou de aprovação).
      throw transitionNotAvailable();
    }

    // RN-WF2-20: regras `STAGE_EXIT` do join + `TRANSITION` da saída sobre o processo INTEIRO,
    // avaliadas uma vez, antes de qualquer escrita (FA-03: nada muda numa recusa).
    const evaluation = await this.workflow.evaluateTransition(
      tx,
      joinStateOf(scope.runtime, target, joinStage, now),
      { transitionId: exit.id, action: 'FORWARD' },
    );
    if (evaluation === null) throw transitionNotAvailable();
    const blocking = blockingViolations(evaluation.violations);
    if (blocking.length > 0) throw transitionBlocked(evaluation.violations, blocking.length);
    if (request.acknowledgedWarnings !== undefined) {
      const pending = unacknowledgedWarnings(evaluation.violations, request.acknowledgedWarnings);
      if (pending.length > 0) throw warningsNotAcknowledged(pending);
    }

    // RN-WF2-21 (FA-04): unidade, responsável, prazo e aprovador da etapa de saída ANTES das
    // escritas; documentos cobertos submetidos como no encaminhamento (US-051 · DEC-018).
    const next = await this.entries.resolve(tx, {
      stage: nextStage,
      process: real,
      runtime: scope.runtime,
      now,
    });
    const approvalId = next.approvalPlan === null ? null : newId();
    const coverage: StageCoverage[] = [];
    if (approvalId !== null) {
      const documents = await this.documents.movementDocumentsIn(tx, real.id);
      for (const document of coveredDocuments(documents, nextStage.approvalDocumentTypeCodes)) {
        const entry = await this.documents.enterApprovalStageIn(tx, {
          documentId: document.id,
          approvalId,
          acknowledgedWarnings: request.acknowledgedWarnings ?? [],
        });
        coverage.push({
          documentId: document.id,
          documentVersionId: entry.documentVersionId,
          documentCode: entry.document.code,
        });
      }
    }

    const branchMovementId = input.ids.movement;
    const joinId = newId();
    const lastStageSequence = input.lastStageSequence;
    const statusTo: ProcessStatus = statusOnEntering(nextStage.type);
    const branchMovement = this.movement(input, {
      id: branchMovementId,
      sequence: input.lastMovementSequence + 1,
      action: 'FORWARD',
      transitionId: input.transitionId,
      from: target,
      toProcessStageId: joinId,
      toWorkflowStageId: joinStage.id,
      toDepartmentId: target.departmentId,
      toUserId: null,
      statusFrom: real.status,
      statusTo,
      branchKey: branch.branchKey,
      splitProcessStageId: splitId,
    });
    const joinEntry: StageEntry = {
      id: joinId,
      tenantId: real.tenantId,
      processId: real.id,
      workflowStageId: joinStage.id,
      sequence: lastStageSequence + 1,
      departmentId: target.departmentId,
      assigneeId: null,
      enteredAt: now,
      dueAt: null,
      slaDays: null,
      slaType: null,
      dueDateOverridden: false,
      dueDateOverrideReason: null,
      enteredViaMovementId: branchMovementId,
      stageType: 'PARALLEL_JOIN',
      branchKey: null,
      splitProcessStageId: null,
      finishedAt: now,
    };
    const labels = await this.support.labels(tx, {
      fromStage: joinStage.name,
      toStage: nextStage.name,
      fromDepartmentId: target.departmentId,
      toDepartmentId: next.departmentId,
      fromUserId: null,
      toUserId: next.assigneeId,
    });
    // A saída da junção pelo plano do MVP 1 (passagem, responsabilidade e movimento seguintes).
    const exitPlan = planStageTransition({
      process: { ...real, status: statusTo },
      active: {
        id: joinId,
        workflowStageId: joinStage.id,
        sequence: joinEntry.sequence,
        departmentId: joinEntry.departmentId,
        assigneeId: null,
      },
      lastStageSequence: joinEntry.sequence,
      lastMovementSequence: branchMovement.sequence,
      action: 'FORWARD',
      closeAs: 'COMPLETED',
      transitionId: exit.id,
      toWorkflowStageId: nextStage.id,
      toStageType: nextStage.type,
      toDepartmentId: next.departmentId,
      toUserId: next.assigneeId,
      assignedById: null,
      slaDays: nextStage.slaDays,
      slaType: nextStage.slaType,
      dueAt: next.dueAt,
      dueDateOverrideReason: null,
      statusTo,
      comment: null,
      documents: [],
      approvalId: null,
      metadata: movementMetadataSchema.parse({
        v: MOVEMENT_METADATA_VERSION,
        computedDueAt: next.dueAt?.toISOString() ?? null,
        dueDateOverridden: false,
        ...(approvalId === null ? {} : { approvalRequestedId: approvalId }),
        labels,
      }),
      numbering: null,
      actor: input.actor,
      now,
      ids: { stage: newId(), assignment: newId(), movement: newId() },
    });
    const after: Process = exitPlan.process;
    const exitMovement = { ...exitPlan.movement, statusFrom: statusTo, branchKey: null };
    const others = activeStagesOf(scope.rows.stages).filter((stage) => stage.id !== target.id);
    await this.write(tx, {
      process: after,
      expectedVersion: real.version,
      completion: null,
      closeStages: [
        {
          id: target.id,
          status: 'COMPLETED',
          exitedAt: now,
          exitedViaMovementId: branchMovementId,
        },
        // Defensivo: a junção nunca deixa etapa ativa órfã (só há outras se a base divergiu).
        ...others.map((stage): StageClosure => ({
          id: stage.id,
          status: 'CANCELED',
          exitedAt: now,
          exitedViaMovementId: branchMovementId,
        })),
        { id: splitId, status: 'COMPLETED', exitedAt: now, exitedViaMovementId: exitMovement.id },
      ],
      insertStages: [joinEntry, stageEntryOf(exitPlan.entered)],
      insertAssignments: [exitPlan.assignment],
      insertBranches: [],
      updateBranches: [{ id: branch.id, status: 'ARRIVED', at: now, cancellationReason: null }],
      movements: [branchMovement, exitMovement],
    });

    let openedApproval: OpenedApproval | null = null;
    if (next.approvalPlan !== null && approvalId !== null) {
      openedApproval = await this.approvals.requestForStageIn(tx, {
        approvalId,
        processId: real.id,
        processStageId: exitPlan.entered.id,
        stageName: nextStage.name,
        plan: next.approvalPlan,
        coverage,
        authorIds: () => this.documents.coverageAuthorsIn(tx, coverage),
        requestedById: input.actor.userId,
        requestedAt: now,
        requestComment: null,
        dueAt: exitPlan.entered.dueAt,
      });
    }

    const branchDepartmentIds = [
      ...new Set(
        scope.rows.stages
          .filter((stage) => stage.splitProcessStageId === splitId)
          .map((stage) => stage.departmentId),
      ),
    ].filter((departmentId) => departmentId !== next.departmentId);
    await this.outbox.record(
      tx,
      ProcessBranchArrived.of({
        aggregateId: real.id,
        processId: real.id,
        payload: {
          splitProcessStageId: splitId,
          branchKey: branch.branchKey,
          processStageId: target.id,
          movementId: branchMovementId,
          openBranchesLeft: 0,
        },
      }),
    );
    await this.outbox.record(
      tx,
      ProcessBranchesJoined.of({
        aggregateId: real.id,
        processId: real.id,
        payload: {
          splitProcessStageId: splitId,
          joinProcessStageId: joinId,
          nextStage: {
            processStageId: exitPlan.entered.id,
            key: nextStage.key,
            type: nextStage.type,
          },
          toDepartmentId: next.departmentId,
          toUserId: next.assigneeId,
          branchDepartmentIds,
        },
      }),
    );
    await this.stageChanged(tx, {
      cause: 'FORWARD',
      movementId: exitMovement.id,
      process: after,
      from: { processStageId: joinId, key: joinStage.key },
      to: { processStageId: exitPlan.entered.id, key: nextStage.key, type: nextStage.type },
      fromDepartmentId: target.departmentId,
      toDepartmentId: next.departmentId,
      toUserId: next.assigneeId,
      dueAt: exitPlan.entered.dueAt,
      documentIds: [],
      hasComment: false,
      approvalId,
      branchKey: null,
      splitProcessStageId: null,
      actives: [stageEntryOf(exitPlan.entered)],
    });
    await this.statusChanged(tx, real, after, request.statusCause);
    await this.assigned(tx, after, exitPlan.entered, null, 'STAGE_ENTRY');
    await this.audit.record(tx, {
      action: 'process.branch_join',
      entityType: 'Process',
      entityId: real.id,
      processId: real.id,
      changes: [
        { path: 'currentStageId', old: real.currentStageId, new: after.currentStageId },
        { path: 'status', old: real.status, new: after.status },
        { path: 'activeStagesCount', old: real.activeStagesCount ?? 1, new: 1 },
      ],
      metadata: {
        splitProcessStageId: splitId,
        joinProcessStageId: joinId,
        nextStageKey: nextStage.key,
        rulesEvaluated: evaluation.violations.length,
        approvalRequestedId: approvalId,
      },
    });
    this.logger.log(
      {
        event: 'process.branches_joined',
        processId: real.id,
        nextStageKey: nextStage.key,
        durationMs: Math.round(performance.now() - startedAt),
        correlationId: input.actor.correlationId,
      },
      'process.branches_joined',
    );
    await this.checkInvariants(tx, after);
    return {
      process: after,
      expectedVersion: real.version,
      closed: {
        id: target.id,
        status: 'COMPLETED',
        exitedAt: now,
        exitedViaMovementId: branchMovementId,
      },
      entered: exitPlan.entered,
      assignment: exitPlan.assignment,
      movement: branchMovement,
      completion: null,
      branch: {
        kind: 'JOINED',
        branchKey: branch.branchKey,
        splitProcessStageId: splitId,
        joinProcessStageId: joinId,
        openedApproval,
      },
    };
  }

  /* ── Devolução para antes da ramificação (RN-WF2-23) ──────────────────────────────────────── */

  async leave(tx: TenantTx, request: BranchRequest): Promise<AppliedTransition> {
    const { scope } = request;
    const { target } = scope;
    const input = request.transition;
    const { now } = input;
    const real = scope.rows.process;
    const splitId = target.splitProcessStageId ?? '';
    const branchKey = target.branchKey ?? '';
    await this.processes.lockStage(tx, splitId);
    const openBranches = scope.rows.branches.filter(
      (branch) => branch.splitProcessStageId === splitId && branch.status === 'OPEN',
    );
    const otherActives = scope.rows.stages.filter(
      (stage) =>
        stage.status === 'ACTIVE' &&
        stage.splitProcessStageId === splitId &&
        stage.id !== target.id,
    );
    const plan = planStageTransition({
      ...input,
      branchKey: null,
      splitProcessStageId: null,
      metadata: {
        ...input.metadata,
        branch: { splitProcessStageId: splitId, branchKey },
        canceledBranches: openBranches.map((branch) => branch.branchKey),
      },
    });
    const after: Process = { ...plan.process, activeStagesCount: 1 };
    const movement = { ...plan.movement, statusFrom: real.status, branchKey };
    const reason = PROCESS_BRANCH_MESSAGES.returnedBeforeSplit;
    const branchChanges: BranchChange[] = openBranches.map((branch) => ({
      id: branch.id,
      status: 'CANCELED',
      at: now,
      cancellationReason: reason,
    }));
    await this.write(tx, {
      process: after,
      expectedVersion: plan.expectedVersion,
      completion: null,
      closeStages: [
        plan.closed,
        ...otherActives.map((stage): StageClosure => ({
          id: stage.id,
          status: 'CANCELED',
          exitedAt: now,
          exitedViaMovementId: movement.id,
        })),
        { id: splitId, status: 'RETURNED', exitedAt: now, exitedViaMovementId: movement.id },
      ],
      insertStages: [stageEntryOf(plan.entered)],
      insertAssignments: [plan.assignment],
      insertBranches: [],
      updateBranches: branchChanges,
      movements: [movement],
    });
    // Aprovações pendentes das etapas canceladas dos outros ramos; os cobertos voltam a `DRAFT`.
    const canceled = await this.approvals.cancelPendingForStagesIn(
      tx,
      real.id,
      otherActives.map((stage) => stage.id),
      now,
      input.actor.userId,
    );
    for (const approval of canceled) {
      for (const documentId of approval.documentIds) {
        await this.documents.releaseCanceledApprovalIn(tx, {
          documentId,
          approvalId: approval.approvalId,
          reason,
        });
      }
    }
    const canceledApprovalIds = canceled.map((approval) => approval.approvalId);
    const branchDepartmentIds = [
      ...new Set(
        scope.rows.stages
          .filter((stage) => stage.splitProcessStageId === splitId)
          .map((stage) => stage.departmentId),
      ),
    ].filter((departmentId) => departmentId !== plan.entered.departmentId);
    await this.stageChanged(tx, {
      cause: request.cause,
      movementId: movement.id,
      process: after,
      from: { processStageId: target.id, key: request.fromStageKey },
      to: { processStageId: plan.entered.id, key: request.toStage.key, type: request.toStage.type },
      fromDepartmentId: target.departmentId,
      toDepartmentId: plan.entered.departmentId,
      toUserId: plan.entered.assigneeId,
      dueAt: plan.entered.dueAt,
      documentIds: [],
      hasComment: movement.comment !== null,
      approvalId: request.requestedApprovalId,
      branchKey: null,
      splitProcessStageId: null,
      actives: [stageEntryOf(plan.entered)],
    });
    await this.statusChanged(tx, real, after, request.statusCause);
    await this.assigned(tx, after, plan.entered, target.assigneeId, plan.assignment.type);
    const canceledBranchKeys = openBranches.map((branch) => branch.branchKey);
    await this.outbox.record(
      tx,
      ProcessBranchesCanceled.of({
        aggregateId: real.id,
        processId: real.id,
        payload: {
          splitProcessStageId: splitId,
          canceledBranchKeys,
          canceledApprovalIds,
          movementId: movement.id,
          toProcessStageId: plan.entered.id,
          branchDepartmentIds,
        },
      }),
    );
    await this.audit.record(tx, {
      action: 'process.branch_cancel',
      entityType: 'Process',
      entityId: real.id,
      processId: real.id,
      changes: [
        { path: 'currentStageId', old: real.currentStageId, new: after.currentStageId },
        { path: 'activeStagesCount', old: real.activeStagesCount ?? 1, new: 1 },
      ],
      metadata: { canceledBranchKeys, canceledApprovalIds, reason },
    });
    this.logger.log(
      {
        event: 'process.branches_canceled',
        processId: real.id,
        canceledBranchKeys,
        canceledApprovals: canceledApprovalIds.length,
        correlationId: input.actor.correlationId,
      },
      'process.branches_canceled',
    );
    await this.checkInvariants(tx, after);
    return {
      ...plan,
      process: after,
      movement,
      branch: {
        kind: 'CANCELED',
        branchKey,
        splitProcessStageId: splitId,
        canceledBranchKeys,
        canceledApprovalIds,
      },
    };
  }

  /* ── Apoio ────────────────────────────────────────────────────────────────────────────────── */

  private async write(tx: TenantTx, change: RuntimeChange): Promise<void> {
    if (!(await this.processes.applyRuntimeChange(tx, change))) {
      // A trava garante a versão; divergir aqui é escrita fora da trava (a rede do `WHERE version`).
      throw forwardVersionConflict(change.expectedVersion, change.expectedVersion + 1);
    }
  }

  private async definitionOf(tx: TenantTx, versionId: string): Promise<WorkflowSnapshot> {
    const definition = await this.workflow.publishedDefinitionIn(tx, versionId);
    if (definition === null) throw transitionNotAvailable();
    return definition;
  }

  /** Ordem de exibição dos ramos do split (a das transições de saída — RN-WF2-14). */
  private async orderOf(
    tx: TenantTx,
    process: Process,
    rows: ProcessAggregateRows,
    splitId: string,
  ): Promise<BranchOrder> {
    const split = rows.stages.find((stage) => stage.id === splitId);
    if (split === undefined) return new Map();
    const definition = await this.definitionOf(tx, process.workflowVersionId);
    const order = new Map<string, number>();
    definition.transitions
      .filter((transition) => transition.fromStageId === split.workflowStageId)
      .sort(byDisplay)
      .forEach((transition, index) => {
        const stage = definition.stages.find((candidate) => candidate.id === transition.toStageId);
        if (stage !== undefined) order.set(stage.branchKey ?? stage.key, index);
      });
    return order;
  }

  /** Movimento de ramo montado à mão (chegada sem passagem de destino e entrada na junção). */
  private movement(
    input: StageTransitionInput,
    fields: {
      readonly id: string;
      readonly sequence: number;
      readonly action: 'FORWARD';
      readonly transitionId: string | null;
      readonly from: ProcessStageRow;
      readonly toProcessStageId: string | null;
      readonly toWorkflowStageId: string;
      readonly toDepartmentId: string;
      readonly toUserId: string | null;
      readonly statusFrom: ProcessStatus;
      readonly statusTo: ProcessStatus;
      readonly branchKey: string;
      readonly splitProcessStageId: string;
    },
  ): ProcessMovementRecord & { readonly branchKey: string } {
    const context = currentRequestContext();
    return {
      id: fields.id,
      tenantId: input.process.tenantId,
      processId: input.process.id,
      sequence: fields.sequence,
      action: fields.action,
      workflowTransitionId: fields.transitionId,
      fromProcessStageId: fields.from.id,
      toProcessStageId: fields.toProcessStageId,
      fromWorkflowStageId: fields.from.workflowStageId,
      toWorkflowStageId: fields.toWorkflowStageId,
      fromDepartmentId: fields.from.departmentId,
      toDepartmentId: fields.toDepartmentId,
      fromUserId: fields.from.assigneeId,
      toUserId: fields.toUserId,
      statusFrom: fields.statusFrom,
      statusTo: fields.statusTo,
      actorType: 'USER',
      actorId: input.actor.userId,
      actorDepartmentId: fields.from.departmentId,
      comment: input.comment,
      dueAt: null,
      documents: input.documents,
      approvalId: input.approvalId,
      ip: input.actor.ip === '' ? null : input.actor.ip,
      userAgent:
        input.actor.userAgent === null || input.actor.userAgent === ''
          ? null
          : input.actor.userAgent.slice(0, 512),
      correlationId: input.actor.correlationId || (context?.correlationId ?? ''),
      metadata: {
        ...input.metadata,
        branch: { splitProcessStageId: fields.splitProcessStageId, branchKey: fields.branchKey },
      },
      occurredAt: input.now,
      branchKey: fields.branchKey,
    };
  }

  /** `ProcessStageChanged` com os campos aditivos do paralelismo (events.md MVP 2 §2). */
  private async stageChanged(
    tx: TenantTx,
    event: {
      readonly cause: StageChangeCause;
      readonly movementId: string;
      readonly process: Process;
      readonly from: { readonly processStageId: string; readonly key: string };
      readonly to: {
        readonly processStageId: string;
        readonly key: string;
        readonly type: WorkflowSnapshotStage['type'];
      };
      readonly fromDepartmentId: string;
      readonly toDepartmentId: string;
      readonly toUserId: string | null;
      readonly dueAt: Date | null;
      readonly documentIds: readonly string[];
      readonly hasComment: boolean;
      readonly approvalId: string | null;
      readonly branchKey: string | null;
      readonly splitProcessStageId: string | null;
      readonly actives: readonly Pick<BranchAwareStage, 'id' | 'departmentId'>[];
    },
  ): Promise<void> {
    await this.outbox.record(
      tx,
      ProcessStageChanged.of({
        aggregateId: event.process.id,
        processId: event.process.id,
        payload: {
          cause: event.cause,
          movementId: event.movementId,
          fromStage: event.from,
          toStage: event.to,
          fromDepartmentId: event.fromDepartmentId,
          toDepartmentId: event.toDepartmentId,
          toUserId: event.toUserId,
          dueAt: event.dueAt?.toISOString() ?? null,
          documentIds: [...event.documentIds],
          hasComment: event.hasComment,
          approvalId: event.approvalId,
          branchKey: event.branchKey,
          splitProcessStageId: event.splitProcessStageId,
          activeStageIds: event.actives.map((stage) => stage.id),
          activeDepartmentIds: [...new Set(event.actives.map((stage) => stage.departmentId))],
        },
      }),
    );
  }

  /** `ProcessStatusChanged` só quando o status macro muda (RN-WF2-16). */
  private async statusChanged(
    tx: TenantTx,
    before: Process,
    after: Process,
    cause: StatusChangeCause,
  ): Promise<void> {
    if (before.status === after.status) return;
    await this.outbox.record(
      tx,
      ProcessStatusChanged.of({
        aggregateId: after.id,
        processId: after.id,
        payload: {
          fromStatus: before.status,
          toStatus: after.status,
          cause,
          reasonProvided: false,
        },
      }),
    );
  }

  private async assigned(
    tx: TenantTx,
    process: Process,
    entered: EnteredPass,
    fromUserId: string | null,
    type: ProcessAssignmentRecord['type'],
  ): Promise<void> {
    if (entered.assigneeId === null) return;
    await this.outbox.record(
      tx,
      ProcessAssigned.of({
        aggregateId: process.id,
        processId: process.id,
        payload: {
          processStageId: entered.id,
          departmentId: entered.departmentId,
          fromUserId,
          toUserId: entered.assigneeId,
          assignmentType: type === 'RETURN' ? 'RETURN' : 'STAGE_ENTRY',
          hasReason: false,
        },
      }),
    );
  }

  /** `error process.branch_invariant_violated` (story · Logs): nunca deveria acontecer. */
  private async checkInvariants(tx: TenantTx, process: Process): Promise<void> {
    const rows = await this.processes.loadAggregate(tx, process.id);
    if (rows === null) return;
    const violations = branchInvariantViolations(rows.process, rows.stages, rows.branches);
    if (violations.length === 0) return;
    this.logger.error(
      {
        event: 'process.branch_invariant_violated',
        processId: process.id,
        violations,
        correlationId: currentRequestContext()?.correlationId,
      },
      'process.branch_invariant_violated',
    );
  }
}

/** Etapa da versão fixada (o snapshot publicado — RN-WF-33). */
function stageOf(definition: WorkflowSnapshot, stageId: string): WorkflowSnapshotStage {
  const stage = definition.stages.find((candidate) => candidate.id === stageId);
  if (stage === undefined) throw transitionNotAvailable();
  return stage;
}

/** Passagem nova vista como etapa ativa (status macro e desnormalizações). */
function awareOf(entry: StageEntry, openedByReturn: boolean): BranchAwareStage {
  return {
    id: entry.id,
    workflowStageId: entry.workflowStageId,
    sequence: entry.sequence,
    status: 'ACTIVE',
    departmentId: entry.departmentId,
    assigneeId: entry.assigneeId,
    enteredAt: entry.enteredAt,
    exitedAt: null,
    dueAt: entry.dueAt,
    stageType: entry.stageType,
    branchKey: entry.branchKey,
    splitProcessStageId: entry.splitProcessStageId,
    openedByReturn,
  };
}

/** Responsabilidade da entrada na passagem (sem autor). */
function entryAssignment(
  entry: StageEntry,
  type: 'STAGE_ENTRY' | 'RETURN',
): ProcessAssignmentRecord {
  return {
    id: newId(),
    tenantId: entry.tenantId,
    processId: entry.processId,
    processStageId: entry.id,
    departmentId: entry.departmentId,
    assigneeId: entry.assigneeId,
    type,
    assignedById: null,
    startedAt: entry.enteredAt,
  };
}

/**
 * Estado sintético para as regras da junção (RN-WF2-20): o processo inteiro, com a etapa do ramo
 * que chega já concluída e a junção como a etapa ativa (as demais ativas — o split — ficam de fora).
 */
export function joinStateOf(
  runtime: ProcessRuntime,
  target: Pick<
    ProcessStageRow,
    | 'id'
    | 'workflowStageId'
    | 'sequence'
    | 'departmentId'
    | 'assigneeId'
    | 'enteredAt'
    | 'splitProcessStageId'
  >,
  joinStage: WorkflowSnapshotStage,
  now: Date,
) {
  const state = executionStateOf(runtime);
  const passes = state.passes.filter((pass) => pass.status !== 'ACTIVE');
  const maxSequence = Math.max(0, ...state.passes.map((pass) => pass.sequence));
  return {
    ...state,
    status: 'IN_PROGRESS' as const,
    passes: [
      ...passes,
      {
        processStageId: target.id,
        workflowStageId: target.workflowStageId,
        sequence: target.sequence,
        status: 'COMPLETED' as const,
        departmentId: target.departmentId,
        assigneeId: target.assigneeId,
        enteredAt: target.enteredAt.toISOString(),
        exitedAt: now.toISOString(),
      },
      {
        processStageId: `join:${target.splitProcessStageId ?? ''}`,
        workflowStageId: joinStage.id,
        sequence: maxSequence + 1,
        status: 'ACTIVE' as const,
        departmentId: target.departmentId,
        assigneeId: null,
        enteredAt: now.toISOString(),
        exitedAt: null,
      },
    ],
  };
}
