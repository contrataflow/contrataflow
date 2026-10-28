import type { AppConfig as ApiJobsConfig, RunningApiJobs } from '@contrataflow/api/jobs';
import type { Logger as PinoLogger } from '@contrataflow/observability';
import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as NestPinoLogger } from 'nestjs-pino';

import type { OutboxRuntimeConfig } from '#config/outbox.js';
import type { QueueRuntimeConfig } from '#config/queues.js';
import type { SessionsRuntimeConfig } from '#config/sessions.js';

import { attachApiJobs } from './api-jobs/api-jobs.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess, ShutdownSignal } from './graceful-shutdown.js';
import { createWorkerLogger } from './observability/worker-logger.js';
import { startWorkerOps } from './observability/worker-ops.js';
import type { RunningWorkerOps, WorkerOpsOptions } from './observability/worker-ops.js';
import { WorkerModule } from './worker.module.js';

export interface StartWorkerOptions {
  /** Processo observado para SIGTERM/SIGINT (padrão: `process`). */
  readonly proc?: ShutdownProcess;
  /** `false` silencia o logger do Nest (testes). */
  readonly logger?: false;
  /** Logger pino raiz (padrão: stdout, nível `info` — RN-FND-71). */
  readonly rootLogger?: PinoLogger;
  /** Relay do outbox e consumidor de `domain-events` (US-082); ausente = desligados. */
  readonly outbox?: OutboxRuntimeConfig | null;
  /** Redis de sessões do encerramento por vínculo (US-088); ausente = descarta com aviso. */
  readonly sessions?: SessionsRuntimeConfig | null;
  /** Filas, schedulers e Bull Board (US-083); ausente = derivado do outbox ou desligado. */
  readonly queues?: QueueRuntimeConfig | null;
  /**
   * Porta interna `/health/*` + `/metrics` (US-085); ausente = não sobe (testes). O logger das
   * transições de saúde é o `rootLogger`.
   */
  readonly ops?: Omit<WorkerOpsOptions, 'logger'> | null;
  /**
   * Jobs dos módulos da API — PDF, varredura de anexos e IA (DEC-052); ausente = não consumidos
   * (os jobs esperam na fila). Só sobem com as filas.
   */
  readonly apiJobs?: ApiJobsConfig | null;
}

export interface RunningWorker {
  readonly context: INestApplicationContext;
  /** Contexto de jobs da API (`null` sem `apiJobs` ou sem filas). */
  readonly apiJobs: RunningApiJobs | null;
  /** Porta interna de administração (`null` sem `ops`). */
  readonly ops: RunningWorkerOps | null;
  /** Resolvida após o encerramento limpo disparado por sinal. */
  readonly stopped: Promise<ShutdownSignal>;
}

/**
 * Sobe o contexto standalone (sem HTTP público), registra `worker.started` e encerra limpo
 * em SIGTERM/SIGINT. Sem o outbox configurado, um temporizador mantém o processo ativo.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<RunningWorker> {
  const silent = options.logger === false;
  const rootLogger =
    options.rootLogger ??
    createWorkerLogger({ environment: 'local', version: '0.0.0+local', logLevel: 'info' });
  const context = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(rootLogger, {
      outbox: options.outbox ?? null,
      sessions: options.sessions ?? null,
      queues: options.queues ?? null,
    }),
    silent ? { logger: false } : { bufferLogs: true },
  );
  if (!silent) context.useLogger(context.get(NestPinoLogger));
  const logger = new Logger('Bootstrap');
  let apiJobs: RunningApiJobs | null = null;
  if (options.apiJobs) {
    try {
      // Depois do bootstrap: o contexto da API usa o logger pino do worker (sem segundo OTel).
      apiJobs = await attachApiJobs(context, {
        config: options.apiJobs,
        logger: silent ? false : context.get(NestPinoLogger),
      });
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  const keepAlive = setInterval(() => undefined, 60_000);
  // Readiness só depois do startup (observability.md §6.1): a porta sobe com o contexto pronto.
  const ops = options.ops ? await startWorkerOps({ ...options.ops, logger: rootLogger }) : null;
  logger.log(
    { event: 'worker.started', ...(ops ? { metricsPort: ops.port } : {}) },
    'worker started',
  );

  const stopped = registerGracefulShutdown(
    {
      close: async () => {
        clearInterval(keepAlive);
        await ops?.close();
        // Os `Worker`s terminam os jobs em curso antes de o contexto da API fechar o banco.
        await context.close();
        await apiJobs?.close();
      },
    },
    { name: 'worker', logger, ...(options.proc ? { proc: options.proc } : {}) },
  );
  return { context, apiJobs, ops, stopped };
}
