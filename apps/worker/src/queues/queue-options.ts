import type { ConnectionOptions, JobsOptions, MinimalJob } from 'bullmq';

/*
 * Convenções comuns das filas BullMQ (DEC-163 · queues.md §1.2, §2 e §10.1). A US-083 completa o
 * consumo (`runJob`, DLQ, Bull Board); aqui ficam o necessário para o relay e o fan-out.
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

/** `settings.backoffStrategy` dos `Worker`s: só trata o tipo `cf-exponential-jitter`. */
export function backoffStrategy(
  attemptsMade: number,
  type?: string,
  _error?: Error,
  job?: MinimalJob,
): number {
  if (type !== BACKOFF_TYPE) return 0;
  const delay = job?.opts.backoff;
  const base = typeof delay === 'object' && delay.delay ? delay.delay : BACKOFF_BASE_MS;
  return exponentialJitterMs(attemptsMade, base);
}
