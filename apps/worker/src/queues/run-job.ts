import { runInJobContext } from '@contrataflow/observability';
import { isPlatformJob, isRegisteredJob } from '@contrataflow/types';
import type { DeadLetterErrorClass, JobMeta, QueueName } from '@contrataflow/types';
import { jobMetaSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { DelayedError, UnrecoverableError } from 'bullmq';
import type { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import type { CircuitBreaker } from './circuit-breaker.js';
import { buildDeadLetterRecord, deadLetterJobId } from './dead-letter.js';
import type { DeadLetterSink } from './dead-letter.js';
import { runWithJob } from './job-context.js';
import {
  JobTimeoutError,
  PermanentJobError,
  SecurityJobError,
  classifyJobError,
} from './job-errors.js';
import type { JobErrorClass } from './job-errors.js';
import type { JobOutcome, QueueMetrics } from './queue-metrics.js';
import { backoffBaseOf, retryDelayMs } from './queue-options.js';

/*
 * `runJob` (RN-FND-64/66/67 · DEC-164 · queues.md §9.2): todo job do MVP 1 passa por aqui.
 * 1. valida `meta` e `payload` (Zod) — inválido é permanente;
 * 2. aplica a regra de tenant (lista fechada de jobs de plataforma — §9.3);
 * 3. tenant fora de `ACTIVE`: job de negócio conclui sem efeito;
 * 4. abre o span `CONSUMER`, os campos de log e o contexto do job (AsyncLocalStorage);
 * 5. executa o handler com timeout; o banco só pela `TenantTransaction` do tenant do job;
 * 6. classifica o erro: duplicidade → sucesso; dependência fora → adia sem consumir tentativa;
 *    permanente → cópia na `dead-letter` + `UnrecoverableError`; transitório → retry com backoff
 *    ou, na última tentativa, cópia na `dead-letter` antes de relançar.
 */

/** Adiamento do job quando uma dependência está fora (queues.md §10.3). */
export const DEPENDENCY_PAUSE_MS = 30_000;

export type HandlerResult = 'completed' | 'skipped';

export interface JobHandlerContext {
  readonly meta: JobMeta;
  readonly queue: QueueName;
  readonly jobName: string;
  readonly jobId: string;
  /** Tentativa atual, começando em 1. */
  readonly attempt: number;
  /** Abortado no timeout da fila: repasse a `fetch`/SDKs. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Transação com `app.tenant_id` do job (RLS). Job de plataforma não tem tenant: recusa. */
  tenantTransaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
  /** Transação sem tenant — só para jobs de plataforma (lista fechada). */
  platformTransaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

/** Handler de um par fila/job, implementado pelo módulo dono (ex.: `DeadlineScanner`). */
export interface JobHandler<P = unknown> {
  readonly queue: QueueName;
  readonly name: string;
  readonly payloadSchema: z.ZodType<P>;
  /** Aceita `tenantId` nulo para ESTE payload (ex.: evento de plataforma do outbox). */
  acceptsPlatformContext?(payload: P): boolean;
  /** Também roda com o tenant `SUSPENDED` (`tenant-housekeeping` — queues.md §4.8). */
  readonly runsForSuspendedTenant?: boolean;
  /**
   * Roda qualquer que seja o status do tenant (ex.: `domain-events`, cujos handlers leves invalidam
   * caches justamente quando o tenant é suspenso).
   */
  readonly ignoresTenantStatus?: boolean;
  handle(payload: P, context: JobHandlerContext): Promise<HandlerResult | undefined>;
}

/** Estado do tenant no cadastro de plataforma (`null` = inexistente). */
export interface TenantStatusReader {
  findStatus(tenantId: string): Promise<string | null>;
}

/** O `Job` do BullMQ reduzido ao que o wrapper usa. */
export interface RunnableJob {
  readonly id?: string | undefined;
  readonly name: string;
  readonly queueName: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly opts: { readonly attempts?: number; readonly backoff?: unknown };
  readonly timestamp: number;
  readonly processedOn?: number | undefined;
}

export interface RunJobDeps {
  readonly deadLetter: DeadLetterSink;
  readonly metrics: QueueMetrics;
  readonly timeoutMs: number;
  /**
   * `job.moveToDelayed(agora + ms, token)`: devolve o job em `ms` sem consumir tentativa. Com o
   * breaker aberto, os demais jobs da fila também são adiados na hora (queues.md §10.3).
   */
  readonly postpone: (ms: number) => Promise<void>;
  readonly database?: WorkerDatabase | undefined;
  /** Breaker do PostgreSQL: aberto, o job volta à fila sem consumir tentativa. */
  readonly databaseBreaker?: CircuitBreaker | undefined;
  readonly tenants?: TenantStatusReader | undefined;
  readonly now?: () => Date;
}

const logger = new Logger('Worker');

interface Parsed<P> {
  readonly meta: JobMeta;
  readonly payload: P;
}

function validate<P>(job: RunnableJob, handler: JobHandler<P>, jobId: string): Parsed<P> {
  const data = (typeof job.data === 'object' && job.data !== null ? job.data : {}) as {
    meta?: unknown;
    payload?: unknown;
  };
  const meta = jobMetaSchema.safeParse(data.meta);
  if (!meta.success) throw new PermanentJobError('INVALID_JOB_META', 'meta do job inválido');
  const payload = handler.payloadSchema.safeParse(data.payload);
  if (!payload.success)
    throw new PermanentJobError('INVALID_JOB_PAYLOAD', 'payload do job inválido');
  if (
    meta.data.tenantId === null &&
    !isPlatformJob(job.queueName, job.name) &&
    handler.acceptsPlatformContext?.(payload.data) !== true
  ) {
    logger.error({
      event: 'security.tenant_context_missing',
      alert: true,
      queue: job.queueName,
      jobName: job.name,
      jobId,
    });
    throw new SecurityJobError('TENANT_CONTEXT_REQUIRED', 'job de tenant sem tenantId');
  }
  return { meta: meta.data, payload: payload.data };
}

/** `meta` válido dos dados de um job, se houver (para a cópia na dead-letter). */
export function jobMetaOf(data: unknown): JobMeta | null {
  const meta: unknown = (data as { meta?: unknown } | null)?.meta;
  const parsed = jobMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data : null;
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const running = work(controller.signal);
  // Se o timeout vencer, a rejeição tardia do handler não pode virar exceção não tratada.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function contextFor(
  job: RunnableJob,
  jobId: string,
  meta: JobMeta,
  signal: AbortSignal,
  deps: RunJobDeps,
): JobHandlerContext {
  const database = (): WorkerDatabase => {
    if (!deps.database) throw new Error('Banco do worker não configurado (DATABASE_URL_WORKER)');
    return deps.database;
  };
  const guarded = <T>(work: () => Promise<T>): Promise<T> =>
    deps.databaseBreaker ? deps.databaseBreaker.execute(work) : work();
  return {
    meta,
    queue: job.queueName as QueueName,
    jobName: job.name,
    jobId,
    attempt: job.attemptsMade + 1,
    signal,
    logger: new Logger(`${job.queueName}:${job.name}`),
    tenantTransaction: (work) => {
      const { tenantId } = meta;
      if (tenantId === null) {
        return Promise.reject(
          new SecurityJobError('TENANT_CONTEXT_REQUIRED', 'transação de tenant sem tenantId'),
        );
      }
      return guarded(() => database().tenantTransaction(tenantId, work));
    },
    platformTransaction: (work) => {
      if (meta.tenantId !== null) {
        return Promise.reject(
          new SecurityJobError(
            'PLATFORM_CONTEXT_FORBIDDEN',
            'job de tenant sem acesso de plataforma',
          ),
        );
      }
      return guarded(() => database().platformTransaction(work));
    },
  };
}

async function tenantAllowsRun(
  meta: JobMeta,
  handler: JobHandler<never>,
  deps: RunJobDeps,
): Promise<boolean> {
  const { tenantId } = meta;
  if (tenantId === null || !deps.tenants || handler.ignoresTenantStatus === true) return true;
  const reader = deps.tenants;
  const read = () => reader.findStatus(tenantId);
  const status = await (deps.databaseBreaker ? deps.databaseBreaker.execute(read) : read());
  return status === 'ACTIVE' || (status === 'SUSPENDED' && handler.runsForSuspendedTenant === true);
}

function deadLetterClass(errorClass: JobErrorClass, error: unknown): DeadLetterErrorClass {
  if (errorClass === 'SECURITY') return 'SECURITY';
  if (errorClass === 'PERMANENT') return 'PERMANENT';
  return error instanceof JobTimeoutError ? 'TIMEOUT' : 'TRANSIENT_EXHAUSTED';
}

/**
 * Executa um job pelo contrato comum. Devolve o resultado do handler (`completed`/`skipped`) ou
 * `duplicate`; falhas são relançadas como o BullMQ espera (`UnrecoverableError`, `RateLimitError`
 * ou o próprio erro para retry).
 */
export async function runJob<P>(
  job: RunnableJob,
  handler: JobHandler<P>,
  deps: RunJobDeps,
): Promise<HandlerResult | 'duplicate'> {
  const now = deps.now ?? (() => new Date());
  const started = Date.now();
  const jobId = job.id ?? '';
  const attempt = job.attemptsMade + 1;
  const queue = job.queueName;
  if (job.processedOn !== undefined) deps.metrics.jobWaited(queue, job.processedOn - job.timestamp);
  const finish = (outcome: JobOutcome) => {
    deps.metrics.jobProcessed(queue, job.name, outcome, Date.now() - started);
  };

  let meta: JobMeta | null = null;
  try {
    if (queue !== handler.queue || job.name !== handler.name || !isRegisteredJob(queue, job.name)) {
      throw new PermanentJobError('JOB_NOT_REGISTERED', `job ${queue}/${job.name} sem handler`);
    }
    const parsed = validate(job, handler, jobId);
    meta = parsed.meta;
    const active = parsed.meta;
    const result = await runInJobContext(
      { queue, jobName: job.name, jobId, attempt },
      {
        correlationId: active.correlationId,
        tenantId: active.tenantId,
        causationId: active.causationId,
        ...(active.traceparent ? { traceparent: active.traceparent } : {}),
        ...(active.tracestate ? { tracestate: active.tracestate } : {}),
      },
      () =>
        runWithJob({ meta: active, queue, jobName: job.name, jobId }, async () => {
          if (!(await tenantAllowsRun(active, handler as JobHandler<never>, deps))) {
            logger.log({ event: 'job.skipped_tenant_inactive', tenantId: active.tenantId });
            return 'skipped' as const;
          }
          return withTimeout(
            async (signal) =>
              (await handler.handle(
                parsed.payload,
                contextFor(job, jobId, active, signal, deps),
              )) ?? 'completed',
            deps.timeoutMs,
          );
        }),
    );
    finish(result);
    logger.log({
      event: 'worker.job_completed',
      queue,
      jobName: job.name,
      jobId,
      attempt,
      durationMs: Date.now() - started,
      tenantId: active.tenantId,
      correlationId: active.correlationId,
      result,
    });
    return result;
  } catch (error) {
    return handleFailure(error);
  }

  async function handleFailure(error: unknown): Promise<'duplicate'> {
    const errorClass = classifyJobError(error);
    const errorName = error instanceof Error ? error.name : 'Error';
    if (errorClass === 'DUPLICATE') {
      finish('completed');
      logger.log({ event: 'worker.job_duplicate', queue, jobName: job.name, jobId, attempt });
      return 'duplicate';
    }
    if (errorClass === 'DEPENDENCY_DOWN') {
      finish('delayed');
      logger.warn({
        event: 'worker.queue_paused',
        queue,
        dependency: (error as { dependency?: string }).dependency,
        pauseMs: DEPENDENCY_PAUSE_MS,
      });
      await deps.postpone(DEPENDENCY_PAUSE_MS);
      // O job já está em `delayed`: o BullMQ não conta a tentativa (queues.md §10.3).
      throw new DelayedError();
    }
    const maxAttempts = job.opts.attempts ?? 1;
    const final = errorClass !== 'TRANSIENT' || attempt >= maxAttempts;
    if (!final) {
      finish('retried');
      deps.metrics.jobRetried(queue, errorClass);
      const delay = retryDelayMs(jobId || undefined, attempt, backoffBaseOf(job.opts as never));
      logger.warn({
        event: 'worker.job_retried',
        queue,
        jobName: job.name,
        attempt,
        errorClass: errorName,
        nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
      });
      throw error;
    }
    const failedClass = deadLetterClass(errorClass, error);
    // RN-FND-67: a cópia vai para a dead-letter ANTES de o BullMQ marcar o job como `failed`.
    await deps.deadLetter.park(
      deadLetterJobId(queue, jobId),
      buildDeadLetterRecord(
        {
          queue,
          jobName: job.name,
          jobId,
          attemptsMade: attempt,
          enqueuedAt: job.timestamp,
          data: job.data,
          meta: meta ?? jobMetaOf(job.data),
        },
        error,
        failedClass,
        now(),
      ),
    );
    finish('failed');
    logger.error({
      event: 'worker.job_dead_lettered',
      alert: true,
      queue,
      jobName: job.name,
      jobId,
      attempts: attempt,
      errorClass: failedClass,
      errorName,
    });
    if (errorClass === 'TRANSIENT') throw error;
    throw new UnrecoverableError(
      error instanceof PermanentJobError ? error.code : `${failedClass}: ${errorName}`,
    );
  }
}
