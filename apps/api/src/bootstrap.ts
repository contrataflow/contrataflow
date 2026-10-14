import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import type { AppConfig } from '#config/env.js';

import { AppModule } from './app.module.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess, ShutdownSignal } from './graceful-shutdown.js';

/** Prefixo de todas as rotas de negócio (api.md §1.1); `/health/*` e `/metrics` ficam fora (US-085). */
export const API_PREFIX = 'api/v1';

export interface StartApiOptions {
  readonly config: AppConfig;
  /** Sobrescreve a porta da configuração (`0` = porta livre, nos testes). */
  readonly port?: number;
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

/** Ajustes da aplicação HTTP comuns ao bootstrap e aos testes. */
export function configureApiApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX);
  // Express: sem `X-Powered-By`; `req.ip` direto do socket até a US-084 tratar proxies confiáveis.
  (app as NestExpressApplication).disable('x-powered-by');
  return app;
}

/**
 * Cria a aplicação HTTP. O body parser do Express fica desligado: o corpo é lido pelo
 * `JsonBodyMiddleware`, dentro do pipeline e do filtro RFC 9457.
 */
export async function createApiApp(options: Pick<StartApiOptions, 'config' | 'logger'>) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options.config), {
    bodyParser: false,
    ...(options.logger === false ? { logger: false } : {}),
  });
  return configureApiApp(app);
}

/** Sobe a API e registra o encerramento limpo em SIGTERM/SIGINT. */
export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const app = await createApiApp(options);
  const port = options.port ?? options.config.port;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`api.started port=${port}`);
  const stopped = registerGracefulShutdown(app, {
    name: 'api',
    logger,
    ...(options.proc ? { proc: options.proc } : {}),
  });
  return { app, stopped };
}
