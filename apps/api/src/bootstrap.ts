import type { Logger as PinoLogger } from '@contrataflow/observability';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as NestPinoLogger } from 'nestjs-pino';

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
  /** Logger pino raiz (padrão: stdout, conforme a configuração — RN-FND-71). */
  readonly rootLogger?: PinoLogger;
}

export interface RunningApi {
  readonly app: INestApplication;
  /** Resolvida após o encerramento limpo disparado por sinal. */
  readonly stopped: Promise<ShutdownSignal>;
}

/** Ajustes da aplicação HTTP comuns ao bootstrap e aos testes. */
export function configureApiApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(API_PREFIX);
  // Express: sem `X-Powered-By`; `req.ip` direto do socket (o BFF repassa o IP do cliente).
  (app as NestExpressApplication).disable('x-powered-by');
  return app;
}

/**
 * Cria a aplicação HTTP. O body parser do Express fica desligado: o corpo é lido pelo
 * `JsonBodyMiddleware`, dentro do pipeline e do filtro RFC 9457.
 */
export async function createApiApp(
  options: Pick<StartApiOptions, 'config' | 'logger' | 'rootLogger'>,
) {
  const silent = options.logger === false;
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(options.config, options.rootLogger ? { logger: options.rootLogger } : {}),
    { bodyParser: false, ...(silent ? { logger: false } : { bufferLogs: true }) },
  );
  // Todo `Logger` do Nest passa a escrever pelo pino (JSON em stdout, campos de §2.2).
  if (!silent) app.useLogger(app.get(NestPinoLogger));
  return configureApiApp(app);
}

/** Sobe a API e registra o encerramento limpo em SIGTERM/SIGINT. */
export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const app = await createApiApp(options);
  const port = options.port ?? options.config.port;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log({ event: 'api.started', port }, 'api started');
  const stopped = registerGracefulShutdown(app, {
    name: 'api',
    logger,
    ...(options.proc ? { proc: options.proc } : {}),
  });
  return { app, stopped };
}
