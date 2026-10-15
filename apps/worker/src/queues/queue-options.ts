import { createHash } from 'node:crypto';

import type { QueueName } from '@contrataflow/types';
import type { ConnectionOptions, JobsOptions, MinimalJob } from 'bullmq';

/*
 * Convenções comuns das filas BullMQ (DEC-163 · queues.md §1.2, §2, §4 e §10.1): prefixo,
 * conexões, política padrão de jobs, backoff `cf-exponential-jitter`, opções dos `Worker`s e a
 * política (concorrência, timeout) de cada fila do MVP 1.
 */

/** Prefixo das chaves BullMQ: `cf:{env}:q` (coerente com `cf:{env}:…` — permissions.md §1.2). */
export function queuePrefix(appEnv: string): string {
  return `cf:${appEnv}:q`;
}

/**
 * Conexão do produtor (relay e fan-out): sem fila offline, para o `add` falhar rápido com o Redis
 * fora em vez de acumular comandos enquanto a transação do lote segura as travas (FA-01).
 */
export function producerConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  };
}

/** Conexão de consumidor (`Worker` — comandos bloqueantes exigem `maxRetriesPerRequest: null`). */
export function consumerConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null, enableReadyCheck: true };
}

/** Estratégia de backoff própria (queues.md §10.1). */
export const BACKOFF_TYPE = 'cf-exponential-jitter';
export const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CEILING_MS = 15 * 60_000;

/** Política padrão de DEC-163: 5 tentativas, backoff exponencial com jitter, retenção 24 h / 7 d. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: BACKOFF_TYPE, delay: BACKOFF_BASE_MS },
  // Mantém o jobId por 24 h: deduplicação do relay e do fan-out (queues.md §2).
  removeOnComplete: { age: 24 * 3_600 },
  removeOnFail: { age: 7 * 24 * 3_600 },
} as const satisfies JobsOptions;

/**
 * Espera exponencial com *equal jitter*: metade fixa, metade aleatória, teto de 15 min. Com base
 * 5 s: ≈ 2,5–5 s, 5–10 s, 10–20 s, 20–40 s…
 */
export function exponentialJitterMs(
  attempt: number,
  baseMs: number = BACKOFF_BASE_MS,
  random: () => number = Math.random,
): number {
  const exp = Math.min(BACKOFF_CEILING_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Fração de jitter determinística por job e tentativa (0 ≤ x < 1): o `runJob` calcula a mesma
 * espera que o BullMQ aplicará e registra o `nextAttemptAt` exato no log `worker.job_retried`.
 */
export function jitterFraction(jobId: string, attemptsMade: number): number {
  const digest = createHash('sha256')
    .update(`${jobId}#${String(attemptsMade)}`)
    .digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Espera até a próxima tentativa de um job com o backoff `cf-exponential-jitter`. */
export function retryDelayMs(
  jobId: string | undefined,
  attemptsMade: number,
  baseMs: number,
): number {
  const random = jobId ? () => jitterFraction(jobId, attemptsMade) : Math.random;
  return exponentialJitterMs(attemptsMade, baseMs, random);
}

/** Base do backoff declarada no job (padrão 5 s). */
export function backoffBaseOf(opts: Pick<JobsOptions, 'backoff'>): number {
  const delay = opts.backoff;
  return typeof delay === 'object' && delay.delay ? delay.delay : BACKOFF_BASE_MS;
}

/** `settings.backoffStrategy` dos `Worker`s: só trata o tipo `cf-exponential-jitter`. */
export function backoffStrategy(
  attemptsMade: number,
  type?: string,
  _error?: Error,
  job?: MinimalJob,
): number {
  if (type !== BACKOFF_TYPE) return 0;
  return retryDelayMs(job?.id, attemptsMade, job ? backoffBaseOf(job.opts) : BACKOFF_BASE_MS);
}

/**
 * Opções comuns dos `Worker`s (queues.md §2): trava de 30 s renovada automaticamente; job
 * *stalled* verificado a cada 30 s e que derruba o worker duas vezes falha (FA-02 — *poison job*).
 */
export const WORKER_DEFAULTS = {
  lockDuration: 30_000,
  stalledInterval: 30_000,
  maxStalledCount: 1,
} as const;

/** A `dead-letter` não tem consumidor: o job fica em espera até a CLI retentar ou descartar. */
export const DEAD_LETTER_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: false,
  removeOnFail: false,
} as const satisfies JobsOptions;

/** Política de consumo de cada fila (queues.md §4): concorrência por réplica e timeout. */
export interface QueuePolicy {
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Limite global de vazão (`limiter` do BullMQ). */
  readonly limiter?: { readonly max: number; readonly duration: number };
}

export type ConsumedQueue = Exclude<QueueName, 'dead-letter'>;

export const QUEUE_POLICIES: Readonly<Record<ConsumedQueue, QueuePolicy>> = {
  'domain-events': { concurrency: 20, timeoutMs: 10_000 },
  notifications: { concurrency: 10, timeoutMs: 30_000 },
  // 10 envios/s global, alinhado à cota do provedor (queues.md §4.3).
  email: { concurrency: 5, timeoutMs: 30_000, limiter: { max: 10, duration: 1_000 } },
  'document-render': { concurrency: 4, timeoutMs: 60_000 },
  'file-scan': { concurrency: 4, timeoutMs: 90_000 },
  deadlines: { concurrency: 5, timeoutMs: 5 * 60_000 },
  'audit-seal': { concurrency: 2, timeoutMs: 10 * 60_000 },
  maintenance: { concurrency: 2, timeoutMs: 30 * 60_000 },
};
