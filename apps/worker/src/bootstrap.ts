import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess, ShutdownSignal } from './graceful-shutdown.js';
import { WorkerModule } from './worker.module.js';

export interface StartWorkerOptions {
  /** Processo observado para SIGTERM/SIGINT (padrão: `process`). */
  readonly proc?: ShutdownProcess;
  /** `false` silencia o logger do Nest (testes). */
  readonly logger?: false;
}

export interface RunningWorker {
  readonly context: INestApplicationContext;
  /** Resolvida após o encerramento limpo disparado por sinal. */
  readonly stopped: Promise<ShutdownSignal>;
}

/**
 * Sobe o contexto standalone (sem HTTP público), registra `worker.started` e encerra limpo
 * em SIGTERM/SIGINT. Enquanto não há filas, um temporizador mantém o processo ativo.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<RunningWorker> {
  const context = await NestFactory.createApplicationContext(
    WorkerModule,
    options.logger === false ? { logger: false } : {},
  );
  const logger = new Logger('Bootstrap');
  const keepAlive = setInterval(() => undefined, 60_000);
  logger.log('worker.started');

  const stopped = registerGracefulShutdown(
    {
      close: async () => {
        clearInterval(keepAlive);
        await context.close();
      },
    },
    { name: 'worker', logger, ...(options.proc ? { proc: options.proc } : {}) },
  );
  return { context, stopped };
}
