import type { ProcessStatus, StageType } from '@contrataflow/validation';

import type { ProcessAssignmentRecord, ProcessMovementRecord } from './process-runtime-records.js';
import { USER_AGENT_MAX } from './process-runtime-records.js';
import type { Process } from './process.js';

/*
 * Assumir o processo (US-049 · PRC-21 · RN-TRAM-31..35): a passagem ativa SEGUE a mesma — só ganha
 * o responsável individual. Encerra a responsabilidade ativa (a da fila da unidade, se existir),
 * abre a `CLAIM` (`assignedById = null`: o ator já é o `actorId` da tramitação), registra a
 * tramitação `CLAIM` (sem motivo) e devolve o processo com o responsável e `version + 1`. Puro e
 * determinístico: leituras, autorização e gravação são do `ClaimProcessCommand`.
 */

/** RN-TRAM-32: status em que se assume (POL-01: os que têm custódia, menos `DRAFT`). */
const CLAIMABLE_STATUSES: ReadonlySet<ProcessStatus> = new Set(['IN_PROGRESS', 'RETURNED']);

export type ClaimRefusal = 'INVALID_STATUS' | 'ALREADY_ASSIGNED';

/**
 * RN-TRAM-31/32: `INVALID_STATUS` fora de `IN_PROGRESS`/`RETURNED` ou em etapa `APPROVAL`
 * (`Approval`/POL-03 decide, não uma responsabilidade); `ALREADY_ASSIGNED` com responsável
 * individual. `null` = pode assumir. A etapa desconhecida (`null`) não bloqueia.
 */
export function claimRefusal(
  process: Pick<Process, 'status' | 'currentResponsibleId'>,
  stageType: StageType | null,
): ClaimRefusal | null {
  if (!CLAIMABLE_STATUSES.has(process.status) || stageType === 'APPROVAL') return 'INVALID_STATUS';
  return process.currentResponsibleId === null ? null : 'ALREADY_ASSIGNED';
}

/** A passagem ativa do processo travado. */
export interface ClaimedPass {
  readonly id: string;
  readonly workflowStageId: string;
}

export interface ClaimInput {
  /** O processo travado (`SELECT … FOR UPDATE`), antes de assumir. */
  readonly process: Process;
  readonly active: ClaimedPass;
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

/** Tudo o que assumir grava de uma vez. */
export interface ClaimPlan {
  /** O processo depois de assumir (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  /** A passagem ativa que ganha o `assigneeId`. */
  readonly stageId: string;
  /** A responsabilidade ativa é encerrada neste instante. */
  readonly endedAt: Date;
  readonly assignment: ProcessAssignmentRecord;
  readonly movement: ProcessMovementRecord;
}

/** RN-TRAM-33/34: o plano completo de assumir (`CLAIM`, sem autor distinto e sem motivo). */
export function planClaim(input: ClaimInput): ClaimPlan {
  const { process, active, actor, now, ids } = input;
  const userId = actor.userId;
  const movement: ProcessMovementRecord = {
    id: ids.movement,
    tenantId: process.tenantId,
    processId: process.id,
    sequence: input.lastMovementSequence + 1,
    action: 'CLAIM',
    workflowTransitionId: null,
    fromProcessStageId: active.id,
    toProcessStageId: active.id,
    fromWorkflowStageId: active.workflowStageId,
    toWorkflowStageId: active.workflowStageId,
    fromDepartmentId: process.currentDepartmentId,
    toDepartmentId: process.currentDepartmentId,
    fromUserId: process.currentResponsibleId,
    toUserId: userId,
    statusFrom: process.status,
    statusTo: process.status,
    actorType: 'USER',
    actorId: userId,
    actorDepartmentId: process.currentDepartmentId,
    comment: null,
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
      currentResponsibleId: userId,
      updatedAt: now,
      updatedById: userId,
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
      assigneeId: userId,
      type: 'CLAIM',
      assignedById: null,
      startedAt: now,
    },
    movement,
  };
}
