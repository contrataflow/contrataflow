import { assignReasonRequired } from '@contrataflow/validation';
import type { ProcessStatus, StageType } from '@contrataflow/validation';

import type { ProcessAssignmentRecord, ProcessMovementRecord } from './process-runtime-records.js';
import { USER_AGENT_MAX } from './process-runtime-records.js';
import type { Process } from './process.js';

/*
 * Atribuir/reatribuir o responsável (US-050 · PRC-22 · RN-TRAM-36..42): como assumir, a passagem
 * ativa SEGUE a mesma — só troca (ou perde) o responsável individual. Encerra a responsabilidade
 * ativa, abre a `MANUAL` (`assignedById` = quem atribuiu; `assigneeId = null` = fila da unidade),
 * registra a tramitação `ASSIGN` (motivo no `comment`) e devolve o processo com o novo responsável e
 * `version + 1`. Puro e determinístico: leituras, autorização e gravação são do
 * `AssignProcessCommand`.
 */

/** RN-TRAM-37: status em que se atribui (os mesmos de assumir). */
const ASSIGNABLE_STATUSES: ReadonlySet<ProcessStatus> = new Set(['IN_PROGRESS', 'RETURNED']);

/**
 * RN-TRAM-37: `false` fora de `IN_PROGRESS`/`RETURNED` ou em etapa `APPROVAL` (`Approval`/POL-03
 * decide, não uma responsabilidade). A etapa desconhecida (`null`) não bloqueia.
 */
export function isAssignable(
  process: Pick<Process, 'status'>,
  stageType: StageType | null,
): boolean {
  return ASSIGNABLE_STATUSES.has(process.status) && stageType !== 'APPROVAL';
}

/**
 * RN-TRAM-39: o motivo é exigido sempre que já existe responsável individual (troca ou remoção) e
 * é opcional na primeira atribuição a partir da fila. `true` = falta o motivo.
 */
export function assignReasonMissing(
  process: Pick<Process, 'currentResponsibleId'>,
  reason: string | null,
): boolean {
  return assignReasonRequired(process.currentResponsibleId) && (reason === null || reason === '');
}

/** A passagem ativa do processo travado. */
export interface AssignedPass {
  readonly id: string;
  readonly workflowStageId: string;
}

export interface AssignInput {
  /** O processo travado (`SELECT … FOR UPDATE`), antes da atribuição. */
  readonly process: Process;
  readonly active: AssignedPass;
  /** O novo responsável; `null` = deixar na fila da unidade (RN-TRAM-40). */
  readonly assigneeId: string | null;
  /** Motivo já validado (10–2.000), ou `null` quando não informado. */
  readonly reason: string | null;
  /** Maior `sequence` entre as tramitações do processo. */
  readonly lastMovementSequence: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly actor: {
    readonly userId: string;
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly correlationId: string;
  };
  readonly now: Date;
  readonly ids: { readonly assignment: string; readonly movement: string };
}

/** Tudo o que a atribuição grava de uma vez. */
export interface AssignPlan {
  /** O processo depois da atribuição (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  /** A passagem ativa que recebe o `assigneeId`. */
  readonly stageId: string;
  /** A responsabilidade ativa é encerrada neste instante. */
  readonly endedAt: Date;
  readonly assignment: ProcessAssignmentRecord;
  readonly movement: ProcessMovementRecord;
}

/** RN-TRAM-40/42: o plano completo da atribuição (`MANUAL`, com o autor e o motivo). */
export function planAssign(input: AssignInput): AssignPlan {
  const { process, active, actor, now, ids, assigneeId } = input;
  const movement: ProcessMovementRecord = {
    id: ids.movement,
    tenantId: process.tenantId,
    processId: process.id,
    sequence: input.lastMovementSequence + 1,
    action: 'ASSIGN',
    workflowTransitionId: null,
    fromProcessStageId: active.id,
    toProcessStageId: active.id,
    fromWorkflowStageId: active.workflowStageId,
    toWorkflowStageId: active.workflowStageId,
    fromDepartmentId: process.currentDepartmentId,
    toDepartmentId: process.currentDepartmentId,
    fromUserId: process.currentResponsibleId,
    toUserId: assigneeId,
    statusFrom: process.status,
    statusTo: process.status,
    actorType: 'USER',
    actorId: actor.userId,
    actorDepartmentId: process.currentDepartmentId,
    comment: input.reason,
    dueAt: process.currentStageDueAt,
    documents: [],
    approvalId: null,
    ip: actor.ip === '' ? null : actor.ip,
    userAgent:
      actor.userAgent === null || actor.userAgent === ''
        ? null
        : actor.userAgent.slice(0, USER_AGENT_MAX),
    correlationId: actor.correlationId,
    metadata: input.metadata,
    occurredAt: now,
  };
  return {
    process: {
      ...process,
      currentResponsibleId: assigneeId,
      updatedAt: now,
      updatedById: actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    stageId: active.id,
    endedAt: now,
    assignment: {
      id: ids.assignment,
      tenantId: process.tenantId,
      processId: process.id,
      processStageId: active.id,
      departmentId: process.currentDepartmentId,
      assigneeId,
      type: 'MANUAL',
      assignedById: actor.userId,
      startedAt: now,
    },
    movement,
  };
}
