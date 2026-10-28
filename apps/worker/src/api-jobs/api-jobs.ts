import { classifyApiJobFailure, startApiJobs } from '@contrataflow/api/jobs';
import type { ApiJobHandler, AppConfig, RunningApiJobs } from '@contrataflow/api/jobs';
import { Logger } from '@nestjs/common';
import type { INestApplicationContext, LoggerService } from '@nestjs/common';

import {
  DependencyUnavailableError,
  PermanentJobError,
  SecurityJobError,
} from '../queues/job-errors.js';
import { QueueRuntime } from '../queues/queue.runtime.js';
import type { JobHandler } from '../queues/run-job.js';

/*
 * Ligação da DEC-052 (queues.md §4.4/§4.5/§4.5.1): o worker sobe o contexto de jobs da API
 * (`@contrataflow/api/jobs` — sem HTTP) e executa os seus `TenantJob` pelo `runJob`, com o
 * timeout, a concorrência e o backoff de `queue-options` e a dead-letter do worker.
 */

/** Falha de um job da API na linguagem do `runJob` (queues.md §10.2/§10.3). */
function translateFailure(error: unknown): unknown {
  const failure = classifyApiJobFailure(error);
  switch (failure.kind) {
    case 'deferred':
      // Disjuntor aberto (Gotenberg, ClamAV, provedor de IA): adia sem consumir tentativa.
      return new DependencyUnavailableError(failure.dependency);
    case 'permanent':
      return new PermanentJobError(failure.code);
    case 'security':
      return new SecurityJobError(failure.code);
    case 'transient':
      return error;
  }
}

/** Adaptador `TenantJob` (API) → `JobHandler` (worker). */
export function adaptApiJob(job: ApiJobHandler): JobHandler {
  return {
    queue: job.queue,
    name: job.name,
    payloadSchema: job.payloadSchema,
    // O `TenantJob` confere o status do tenant pela porta da API e conclui sem efeito fora de
    // `ACTIVE` (RN-TEN-12): uma só leitura, pela mesma regra da API.
    ignoresTenantStatus: true,
    async handle(payload, context) {
      try {
        const outcome = await job.process({
          id: context.jobId,
          queue: context.queue,
          name: context.jobName,
          attempt: context.attempt,
          data: { meta: context.meta, payload },
        });
        return outcome === 'completed' ? 'completed' : 'skipped';
      } catch (error) {
        throw translateFailure(error);
      }
    },
  };
}

export interface AttachApiJobsOptions {
  readonly config: AppConfig;
  /** Logger do Nest do worker (pino); `false` silencia (testes). */
  readonly logger: LoggerService | false;
}

/**
 * Sobe o contexto de jobs da API e entrega os handlers ao `QueueRuntime`, que abre os `Worker`s
 * dessas filas. Sem filas no worker, não sobe nada. Filas sem a configuração da dependência
 * (Gotenberg, S3, ClamAV) ficam pausadas: os jobs esperam no Redis.
 */
export async function attachApiJobs(
  context: INestApplicationContext,
  options: AttachApiJobsOptions,
): Promise<RunningApiJobs | null> {
  const logger = new Logger('ApiJobs');
  let runtime: QueueRuntime;
  try {
    runtime = context.get(QueueRuntime, { strict: false });
  } catch {
    logger.warn({ event: 'worker.api_jobs_disabled', reason: 'QUEUES_DISABLED' });
    return null;
  }
  const running = await startApiJobs({ config: options.config, logger: options.logger });
  for (const paused of running.paused) {
    logger.warn(
      {
        event: 'worker.queue_unconfigured',
        queue: paused.queue,
        jobName: paused.name,
        missing: paused.missing,
      },
      'fila pausada até a configuração',
    );
  }
  runtime.consume(running.handlers.map((handler) => adaptApiJob(handler) as JobHandler<never>));
  return running;
}
