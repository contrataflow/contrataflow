import type { ProcessStatus } from '@contrataflow/validation';

import type { ProcessMovementRecord } from './process-runtime-records.js';
import { lifecycleMovement } from './process-suspension.js';
import type { LifecycleInput } from './process-suspension.js';
import type { Process } from './process.js';

/*
 * Concluir o processo (US-010 · DEC-013 · DEC-015 · RN-PROC-111..117) — a rotina de domínio
 * compartilhada pelos dois caminhos: a conclusão MANUAL (PRC-26, transição `COMPLETE` ou etapa
 * atual já `END`) e a AUTOMÁTICA (US-052: aprovação `APPROVE` cuja próxima etapa é `END`). Os dois
 * passam por `completeProcess`, que confere o status de origem (RN-PROC-114) e carimba
 * `completedAt`/`completedById` (RN-PROC-115). `COMPLETED` é final no MVP 1 (RN-PROC-117 —
 * reabertura é PEND-03). Puro e determinístico: custódia, permissão e regras de saída são dos
 * comandos; a gravação, do repositório.
 */

/** Caminho da conclusão (`process.complete.metadata.cause` · log `process.completed`). */
export type CompletionCause = 'MANUAL' | 'APPROVAL';

/** RN-PROC-114: o único status de origem de cada caminho (nunca `DRAFT`/`RETURNED`/`SUSPENDED`). */
const SOURCE_STATUS: Readonly<Record<CompletionCause, ProcessStatus>> = {
  MANUAL: 'IN_PROGRESS',
  APPROVAL: 'AWAITING_APPROVAL',
};

/** `completedAt`/`completedById` do processo concluído (RN-PROC-115). */
export interface ProcessCompletion {
  readonly completedAt: Date;
  readonly completedById: string;
  readonly cause: CompletionCause;
}

/** Status fora do de origem do caminho (o comando responde 409 `INVALID_PROCESS_STATUS`). */
export class ProcessNotCompletableError extends Error {
  constructor(readonly status: ProcessStatus) {
    super(`Processo em ${status} não pode ser concluído.`);
    this.name = 'ProcessNotCompletableError';
  }
}

/** RN-PROC-111/112/114: o processo pode ser concluído por este caminho a partir do status atual. */
export function canCompleteFrom(status: ProcessStatus, cause: CompletionCause): boolean {
  return SOURCE_STATUS[cause] === status;
}

/**
 * `Process.complete(actorId)` (RN-PROC-114/115): o carimbo da conclusão — o ator é quem confirmou
 * (manual) ou o aprovador cuja decisão gerou a conclusão (automática).
 */
export function completeProcess(input: {
  readonly status: ProcessStatus;
  readonly cause: CompletionCause;
  readonly actorId: string;
  readonly now: Date;
}): ProcessCompletion {
  if (!canCompleteFrom(input.status, input.cause)) {
    throw new ProcessNotCompletableError(input.status);
  }
  return { completedAt: input.now, completedById: input.actorId, cause: input.cause };
}

export interface CompleteAtEndInput extends LifecycleInput {
  /** Observação opcional (até 5.000 — `ProcessMovement.comment`). */
  readonly comment: string | null;
}

/** Tudo o que a confirmação na etapa `END` grava de uma vez (FA-03). */
export interface CompleteAtEndPlan {
  /** O processo concluído (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  readonly completion: ProcessCompletion;
  /** A passagem `END` ativa, encerrada como `COMPLETED` com `exitedAt = completedAt` (RN-PROC-116). */
  readonly stage: {
    readonly id: string;
    readonly exitedAt: Date;
    readonly exitedViaMovementId: string;
  };
  readonly movement: ProcessMovementRecord;
}

/**
 * FA-03 (RN-PROC-111/116): a etapa atual já é `END` — a conclusão confirma a passagem ativa (sem
 * transição nomeada): tramitação `COMPLETE` na mesma passagem, passagem e responsabilidade
 * encerradas e o processo `COMPLETED`; `currentResponsibleId` fica como referência histórica.
 */
export function planCompletionAtEnd(input: CompleteAtEndInput): CompleteAtEndPlan {
  const { process, actor, now } = input;
  const completion = completeProcess({
    status: process.status,
    cause: 'MANUAL',
    actorId: actor.userId,
    now,
  });
  const movement = lifecycleMovement(input, 'COMPLETE', 'COMPLETED', input.comment, null);
  return {
    process: {
      ...process,
      status: 'COMPLETED',
      currentStageDueAt: null,
      updatedAt: now,
      updatedById: actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    completion,
    stage: { id: input.active.id, exitedAt: now, exitedViaMovementId: movement.id },
    movement,
  };
}
