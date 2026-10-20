import { FINAL_PROCESS_STATUSES } from '@contrataflow/validation';
import type { ProcessStatus } from '@contrataflow/validation';

import type { ProcessMovementRecord } from './process-runtime-records.js';
import { lifecycleMovement } from './process-suspension.js';
import type { LifecycleInput } from './process-suspension.js';
import type { Process } from './process.js';

/*
 * Cancelar o processo e descartar o rascunho sem número (US-009 · PRC-25/PRC-06 · DEC-013 · DEC-034
 * · RN-PROC-103..110). O cancelamento é definitivo: status `CANCELED` com autor, data e
 * justificativa, a passagem ativa encerrada como `CANCELED` pela tramitação `CANCEL` e o status
 * anterior à suspensão descartado (FA-03). O descarte é exclusão lógica (`deletedAt`/`deletedById`)
 * do rascunho que ainda não tem número, encerrando a passagem ativa sem tramitação. Puro e
 * determinístico: leituras, autorização, aprovações, documentos e gravação são dos comandos.
 */

const FINAL: ReadonlySet<ProcessStatus> = new Set(FINAL_PROCESS_STATUSES);

/** RN-PROC-103: cancela-se a partir de qualquer status não final. */
export function isCancelable(status: ProcessStatus): boolean {
  return !FINAL.has(status);
}

/** Por que o rascunho não pode ser descartado (`null` = pode). */
export type DiscardBlock = 'NOT_DRAFT' | 'NUMBERED';

/** RN-PROC-105: só rascunho (`DRAFT`) com `number` e `code` nulos. */
export function discardBlockOf(
  process: Pick<Process, 'status' | 'number' | 'code'>,
): DiscardBlock | null {
  if (process.status !== 'DRAFT') return 'NOT_DRAFT';
  if (process.number !== null || process.code !== null) return 'NUMBERED';
  return null;
}

/** Campos de cancelamento do processo (`processes.canceled_at`… — RN-PROC-104). */
export interface CancellationFields {
  readonly canceledAt: Date;
  readonly canceledById: string;
  readonly cancellationReason: string;
}

/** A passagem encerrada (RN-PROC-107/109): `status = CANCELED`, `exitedAt` e a tramitação. */
export interface ClosedPass {
  readonly id: string;
  readonly exitedAt: Date;
  /** `null` no descarte (sem tramitação). */
  readonly exitedViaMovementId: string | null;
}

export interface CancelInput extends LifecycleInput {
  /** Justificativa já validada (20–5.000, sem espaços nas pontas). */
  readonly reason: string;
}

/** Tudo o que o cancelamento grava de uma vez (as aprovações e documentos são do comando). */
export interface CancelPlan {
  /** O processo cancelado (`version + 1`). */
  readonly process: Process;
  /** Versão lida sob a trava (`WHERE version` é a rede de segurança). */
  readonly expectedVersion: number;
  readonly cancellation: CancellationFields;
  readonly stage: ClosedPass;
  readonly movement: ProcessMovementRecord;
}

/** RN-PROC-104/107: o plano do cancelamento (status final, passagem encerrada e tramitação `CANCEL`). */
export function planCancellation(input: CancelInput): CancelPlan {
  const { process, actor, now } = input;
  const movement = lifecycleMovement(input, 'CANCEL', 'CANCELED', input.reason, null);
  return {
    process: {
      ...process,
      status: 'CANCELED',
      updatedAt: now,
      updatedById: actor.userId,
      version: process.version + 1,
    },
    expectedVersion: process.version,
    cancellation: { canceledAt: now, canceledById: actor.userId, cancellationReason: input.reason },
    stage: { id: input.active.id, exitedAt: now, exitedViaMovementId: movement.id },
    movement,
  };
}

/** Tudo o que o descarte grava de uma vez (RN-PROC-108/109). */
export interface DiscardPlan {
  readonly processId: string;
  readonly expectedVersion: number;
  readonly deletedAt: Date;
  readonly deletedById: string;
  /** A passagem ativa encerrada (`null` = rascunho sem passagem ativa). */
  readonly stage: ClosedPass | null;
}

export function planDiscard(input: {
  readonly process: Process;
  readonly activeStageId: string | null;
  readonly userId: string;
  readonly now: Date;
}): DiscardPlan {
  return {
    processId: input.process.id,
    expectedVersion: input.process.version,
    deletedAt: input.now,
    deletedById: input.userId,
    stage:
      input.activeStageId === null
        ? null
        : { id: input.activeStageId, exitedAt: input.now, exitedViaMovementId: null },
  };
}
