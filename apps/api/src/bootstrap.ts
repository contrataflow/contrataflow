import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess, ShutdownSignal } from './graceful-shutdown.js';

export interface StartApiOptions {
  readonly port: number;
  /** Processo observado para SIGTERM/SIGINT (padrão: `process`). */
  readonly proc?: ShutdownProcess;
  /** `false` silencia o logger do Nest (testes). */
  readonly logger?: false;
}

export interface RunningApi {
  readonly app: INestApplication;
  /** Resolvida após o encerramento limpo disparado por sinal. */
  readonly stopped: Promise<ShutdownSignal>;
}

/** Cria a aplicação HTTP. O esqueleto completo (filtros RFC 9457, pino, OpenAPI) é da US-080. */
export async function createApiApp(options: Pick<StartApiOptions, 'logger'> = {}) {
  return NestFactory.create(AppModule, options.logger === false ? { logger: false } : {});
}

/** Sobe a API e registra o encerramento limpo em SIGTERM/SIGINT. */
export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const app = await createApiApp(options);
  await app.listen(options.port);
  const logger = new Logger('Bootstrap');
  logger.log(`api.started port=${options.port}`);
  const stopped = registerGracefulShutdown(app, {
    name: 'api',
    logger,
    ...(options.proc ? { proc: options.proc } : {}),
  });
  return { app, stopped };
}
