import type { DayCountType } from '@contrataflow/types';
import type { MovementDocumentRef, ProcessStatus, StageType } from '@contrataflow/validation';

import type { RuntimeChange, StageEntry } from './process-branches.js';
import { completeProcess } from './process-completion.js';
import type { CompletionCause, ProcessCompletion } from './process-completion.js';
import { USER_AGENT_MAX, enterStage, stageEntryAssignment } from './process-runtime-records.js';
import type {
  AccessGrant,
  MovementAction,
  ProcessAssignmentRecord,
  ProcessMovementRecord,
  ProcessStageRecord,
} from './process-runtime-records.js';
import type { Process, ProcessNumber } from './process.js';

/*
 * Mudança de etapa (US-047 · `StageTransitionService` · RN-TRAM-14..17): encerra a passagem ativa
 * e a responsabilidade ativa, abre a nova passagem (`sequence + 1`, `ACTIVE`) com a responsabilidade
 * `STAGE_ENTRY`, registra a tramitação imutável e devolve o processo com as desnormalizações da nova
 * etapa (`current*`, `version + 1`). Puro e determinístico: o mesmo plano serve ao encaminhamento
 * e, depois, à devolução (US-048), à decisão (US-052) e à conclusão (US-010) — quem chama resolve
 * destino, prazo e status e autoriza; o repositório grava o plano numa transação só.
 */

/** A passagem ativa como o plano a lê. */
export interface ActivePass {
  readonly id: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly departmentId: string;
  readonly assigneeId: string | null;
}

/** Encerramento da passagem ativa (`COMPLETED` no avanço, `RETURNED` na devolução). */
export interface ClosedPass {
  readonly id: string;
  readonly status: 'COMPLETED' | 'RETURNED';
  readonly exitedAt: Date;
  readonly exitedViaMovementId: string;
}

/** A nova passagem, com a sobrescrita de prazo quando houver (RN-TRAM-10). */
export interface EnteredPass extends ProcessStageRecord {
  readonly dueDateOverridden: boolean;
  readonly dueDateOverrideReason: string | null;
  /**
   * DOM-09 · RN-PROC-116: a passagem pela etapa `END` nasce encerrada (`COMPLETED`, `exitedAt =
   * enteredAt`) com a responsabilidade encerrada; `null` = passagem ativa.
   */
  readonly finishedAt: Date | null;
}

export type { ProcessCompletion } from './process-completion.js';

export interface StageTransitionInput {
  /** O processo travado (`SELECT … FOR UPDATE`), antes da mudança. */
  readonly process: Process;
  readonly active: ActivePass;
  /** Maior `sequence` entre as passagens do processo (a nova é a seguinte). */
  readonly lastStageSequence: number;
  /** Maior `sequence` entre as tramitações do processo. */
  readonly lastMovementSequence: number;
  readonly action: MovementAction;
  readonly closeAs: ClosedPass['status'];
  readonly transitionId: string | null;
  readonly toWorkflowStageId: string;
  /**
   * Tipo da etapa de destino (snapshot em `ProcessStage.stageType` — US-124); todos os comandos o
   * informam (ausente só nos planos montados pelos testes de domínio anteriores).
   */
  readonly toStageType?: StageType | undefined;
  /** US-124: ramo e split da passagem de destino (herdados dentro do ramo); ausentes no tronco. */
  readonly branchKey?: string | null;
  readonly splitProcessStageId?: string | null;
  readonly toDepartmentId: string;
  /** Responsável da nova passagem; `null` = fila da unidade. */
  readonly toUserId: string | null;
  /** Quem atribuiu diretamente (atribuição no encaminhamento — RN-TRAM-14). */
  readonly assignedById: string | null;
  /** `ProcessAssignment.type` da nova passagem (padrão `STAGE_ENTRY`; `RETURN` na devolução). */
  readonly assignmentType?: 'STAGE_ENTRY' | 'RETURN';
  readonly slaDays: number | null;
  readonly slaType: DayCountType;
  readonly dueAt: Date | null;
  /** Motivo da sobrescrita de prazo (`null` = prazo calculado ou sem prazo). */
  readonly dueDateOverrideReason: string | null;
  readonly statusTo: ProcessStatus;
  readonly comment: string | null;
  readonly documents: readonly MovementDocumentRef[];
  /** Aprovação decidida (US-052); `null` no encaminhamento. */
  readonly approvalId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Autuação junto com a mudança (RN-TRAM-18); `null` = sem número novo. */
  readonly numbering: ProcessNumber | null;
  /**
   * RN-PROC-111/112/116: a etapa de destino é `END` — o processo conclui (`statusTo = COMPLETED`)
   * pela rotina compartilhada (`completeProcess`): `MANUAL` (transição `COMPLETE` — US-010) ou
   * `APPROVAL` (decisão `APPROVE` — US-052). Ausente = mudança de etapa sem conclusão.
   */
  readonly completion?: CompletionCause;
  readonly actor: {
    readonly userId: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly correlationId: string;
  };
  readonly now: Date;
  readonly ids: { readonly stage: string; readonly assignment: string; readonly movement: string };
}

/** Tudo o que a mudança de etapa grava de uma vez (RN-TRAM-21). */
export interface StageTransitionPlan {
  /** O processo depois da mudança (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  readonly closed: ClosedPass;
  readonly entered: EnteredPass;
  readonly assignment: ProcessAssignmentRecord;
  readonly movement: ProcessMovementRecord;
  /** `completedAt`/`completedById` do processo quando a mudança o conclui; senão `null`. */
  readonly completion: ProcessCompletion | null;
}

/** RN-TRAM-14..16: o plano completo da mudança de etapa. */
export function planStageTransition(input: StageTransitionInput): StageTransitionPlan {
  const { process, active, now, ids } = input;
  const stage = enterStage({
    id: ids.stage,
    tenantId: process.tenantId,
    processId: process.id,
    workflowStageId: input.toWorkflowStageId,
    sequence: input.lastStageSequence + 1,
    departmentId: input.toDepartmentId,
    assigneeId: input.toUserId,
    enteredAt: now,
    dueAt: input.dueAt,
    slaDays: input.slaDays,
    slaType: input.slaType,
    movementId: ids.movement,
    stageType: input.toStageType,
    branchKey: input.branchKey ?? null,
    splitProcessStageId: input.splitProcessStageId ?? null,
  });
  const entered: EnteredPass = {
    ...stage,
    dueDateOverridden: input.dueDateOverrideReason !== null,
    dueDateOverrideReason: input.dueDateOverrideReason,
    finishedAt: input.completion === undefined ? null : now,
  };
  const movement: ProcessMovementRecord = {
    id: ids.movement,
    tenantId: process.tenantId,
    processId: process.id,
    sequence: input.lastMovementSequence + 1,
    action: input.action,
    workflowTransitionId: input.transitionId,
    fromProcessStageId: active.id,
    toProcessStageId: stage.id,
    fromWorkflowStageId: active.workflowStageId,
    toWorkflowStageId: stage.workflowStageId,
    fromDepartmentId: active.departmentId,
    toDepartmentId: stage.departmentId,
    fromUserId: active.assigneeId,
    toUserId: stage.assigneeId,
    statusFrom: process.status,
    statusTo: input.statusTo,
    actorType: 'USER',
    actorId: input.actor.userId,
    // A tramitação é feita em nome da unidade de custódia (origem).
    actorDepartmentId: process.currentDepartmentId,
    comment: input.comment,
    dueAt: stage.dueAt,
    documents: input.documents,
    approvalId: input.approvalId,
    ip: input.actor.ip === '' ? null : input.actor.ip,
    userAgent:
      input.actor.userAgent === null || input.actor.userAgent === ''
        ? null
        : input.actor.userAgent.slice(0, USER_AGENT_MAX),
    correlationId: input.actor.correlationId,
    metadata: input.metadata,
    occurredAt: now,
    branchKey: input.branchKey ?? null,
  };
  const numbered = input.numbering;
  // RN-PROC-114/115: o status de origem do caminho e o carimbo — antes de montar o plano.
  const completion: ProcessCompletion | null =
    input.completion === undefined
      ? null
      : completeProcess({
          status: process.status,
          cause: input.completion,
          actorId: input.actor.userId,
          now,
        });
  return {
    process: {
      ...process,
      status: input.statusTo,
      currentStageId: stage.id,
      currentWorkflowStageId: stage.workflowStageId,
      currentDepartmentId: stage.departmentId,
      currentResponsibleId: stage.assigneeId,
      currentStageDueAt: stage.dueAt,
      // US-124: uma etapa ativa no tronco; a mudança para `END` encerra (0).
      activeStagesCount: input.completion === undefined ? 1 : 0,
      ...(numbered === null
        ? {}
        : {
            number: numbered.number,
            year: numbered.year,
            code: numbered.code,
            openedAt: now,
          }),
      updatedAt: now,
      updatedById: input.actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    closed: {
      id: active.id,
      status: input.closeAs,
      exitedAt: now,
      exitedViaMovementId: movement.id,
    },
    entered,
    assignment: stageEntryAssignment(
      ids.assignment,
      stage,
      input.assignedById,
      input.assignmentType ?? 'STAGE_ENTRY',
    ),
    movement,
    completion,
  };
}

/**
 * RN-TRAM-17 (DEC-024 · permissions.md §5): a unidade de origem perde o `CURRENT` e fica com o
 * `HISTORICAL` quando a unidade muda; a de destino ganha o `CURRENT`; o novo responsável, o
 * `RESPONSIBLE` (o anterior fica como histórico).
 */
export function stageChangeAccess(input: {
  readonly fromDepartmentId: string;
  readonly toDepartmentId: string;
  readonly toUserId: string | null;
}): { readonly historicalDepartmentId: string | null; readonly grants: AccessGrant[] } {
  const grants: AccessGrant[] = [
    { principalType: 'DEPARTMENT', departmentId: input.toDepartmentId, reason: 'CURRENT' },
  ];
  if (input.toUserId !== null) {
    grants.push({ principalType: 'USER', userId: input.toUserId, reason: 'RESPONSIBLE' });
  }
  const moved = input.fromDepartmentId !== input.toDepartmentId;
  return { historicalDepartmentId: moved ? input.fromDepartmentId : null, grants };
}

/** Entrada da mudança genérica do runtime (US-124) a partir de uma passagem do plano. */
export function stageEntryOf(entered: EnteredPass): StageEntry {
  return {
    id: entered.id,
    tenantId: entered.tenantId,
    processId: entered.processId,
    workflowStageId: entered.workflowStageId,
    sequence: entered.sequence,
    departmentId: entered.departmentId,
    assigneeId: entered.assigneeId,
    enteredAt: entered.enteredAt,
    dueAt: entered.dueAt,
    slaDays: entered.slaDays,
    slaType: entered.slaType,
    dueDateOverridden: entered.dueDateOverridden,
    dueDateOverrideReason: entered.dueDateOverrideReason,
    enteredViaMovementId: entered.enteredViaMovementId,
    stageType: entered.stageType ?? 'TASK',
    branchKey: entered.branchKey ?? null,
    splitProcessStageId: entered.splitProcessStageId ?? null,
    finishedAt: entered.finishedAt,
  };
}

/** O plano do MVP 1 como mudança genérica do runtime (US-124 · `applyRuntimeChange`). */
export function runtimeChangeOf(plan: StageTransitionPlan): RuntimeChange {
  return {
    process: plan.process,
    expectedVersion: plan.expectedVersion,
    completion: plan.completion,
    closeStages: [plan.closed],
    insertStages: [stageEntryOf(plan.entered)],
    insertAssignments: [plan.assignment],
    insertBranches: [],
    updateBranches: [],
    movements: [{ ...plan.movement, branchKey: plan.movement.branchKey ?? null }],
  };
}
