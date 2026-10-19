import type { DayCountType } from '@contrataflow/types';
import type { MovementDocumentRef, ProcessStatus } from '@contrataflow/validation';

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

/** Conclusão do processo junto com a mudança de etapa (US-052 → etapa `END` — RN-PROC-112). */
export interface ProcessCompletion {
  readonly completedAt: Date;
  readonly completedById: string;
}

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
  /** RN-PROC-112/116: a etapa de destino é `END` — o processo conclui (`statusTo = COMPLETED`). */
  readonly completesProcess?: boolean;
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
  });
  const entered: EnteredPass = {
    ...stage,
    dueDateOverridden: input.dueDateOverrideReason !== null,
    dueDateOverrideReason: input.dueDateOverrideReason,
    finishedAt: input.completesProcess === true ? now : null,
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
  };
  const numbered = input.numbering;
  return {
    process: {
      ...process,
      status: input.statusTo,
      currentStageId: stage.id,
      currentWorkflowStageId: stage.workflowStageId,
      currentDepartmentId: stage.departmentId,
      currentResponsibleId: stage.assigneeId,
      currentStageDueAt: stage.dueAt,
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
    completion:
      input.completesProcess === true
        ? { completedAt: now, completedById: input.actor.userId }
        : null,
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
