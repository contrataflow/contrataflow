import type { QueueName } from '@contrataflow/types';

/*
 * Produtor de jobs da API (padrão B — DEC-163 · queues.md §3): o caso de uso grava a linha de
 * estado no commit e só DEPOIS enfileira, com `jobId` = id da linha (deduplicação natural do
 * BullMQ). O `meta` vem do contexto (`buildJobMeta` — tenant, ator, correlação e trace), nunca à
 * mão. Fila indisponível não desfaz o commit: a linha fica pendente até o reconciliador
 * reenfileirar (FA-05). Adaptadores: BullMQ em `modules/platform` e em memória (modo fake/testes).
 */

export interface EnqueueJobOptions {
  /** Id da linha de estado (ex.: `generationId`). */
  readonly jobId: string;
  /** Tentativas do job (padrão da fila: DEC-163). */
  readonly attempts?: number;
  /** Base do backoff exponencial com jitter (`cf-exponential-jitter`), em ms. */
  readonly backoffMs?: number;
  /** Prioridade BullMQ (1 = mais alta), ex.: prévia de PDF = 1, PDF da versão = 5 (queues.md §4.4). */
  readonly priority?: number;
}

export interface JobQueuePort {
  /** @throws erro de infraestrutura quando a fila está indisponível (o chamador decide). */
  enqueue(
    queue: QueueName,
    name: string,
    payload: unknown,
    options: EnqueueJobOptions,
  ): Promise<void>;
}

export const JOB_QUEUE = Symbol('JobQueue');
