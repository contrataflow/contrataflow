import { scrubText } from '@contrataflow/observability';
import type { DeadLetterErrorClass, DeadLetterRecord, JobMeta } from '@contrataflow/types';

/*
 * Dead letter (RN-FND-67 · queues.md §11.1): o BullMQ não tem DLQ nativa — na falha final o
 * `runJob` grava uma cópia na fila `dead-letter` ANTES de relançar o erro. O `jobId` determinístico
 * `<fila>.<jobId>` torna a gravação idempotente se o processo cair no meio (o `add` repetido é
 * descartado pelo BullMQ).
 */

/** Nome do job na fila `dead-letter` (registro de `QUEUE_JOBS`). */
export const DEAD_LETTER_JOB = 'dead-letter';

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_BYTES = 4_096;

export function deadLetterJobId(queue: string, jobId: string): string {
  return `${queue}.${jobId}`;
}

/** Destino das cópias (fila BullMQ em produção; em memória nos testes). */
export interface DeadLetterSink {
  park(jobId: string, record: DeadLetterRecord): Promise<void>;
}

export interface FailedJobFacts {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly attemptsMade: number;
  /** `job.timestamp` (ms epoch) — primeira entrada na fila. */
  readonly enqueuedAt: number;
  readonly data: unknown;
  readonly meta: JobMeta | null;
}

function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  // Corta no limite de bytes sem deixar um caractere multibyte partido.
  return buffer.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

/** Registro da cópia: mensagem sanitizada (DEC-138) e stack truncado em 4 KB. */
export function buildDeadLetterRecord(
  facts: FailedJobFacts,
  error: unknown,
  errorClass: DeadLetterErrorClass,
  failedAt: Date,
): DeadLetterRecord {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: unknown }).code;
  return {
    meta: facts.meta,
    source: {
      queue: facts.queue,
      jobName: facts.jobName,
      jobId: facts.jobId,
      attemptsMade: facts.attemptsMade,
      firstEnqueuedAt: new Date(facts.enqueuedAt).toISOString(),
      failedAt: failedAt.toISOString(),
    },
    data: facts.data,
    error: {
      class: errorClass,
      name: err.name,
      ...(typeof code === 'string' ? { code } : {}),
      message: scrubText(err.message).slice(0, MAX_MESSAGE_LENGTH),
      ...(err.stack ? { stack: truncateBytes(scrubText(err.stack), MAX_STACK_BYTES) } : {}),
    },
  };
}
