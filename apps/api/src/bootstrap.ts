import type { Logger as PinoLogger } from '@contrataflow/observability';
import {
  installMetrics,
  observeReadiness,
  startMetricsServer,
} from '@contrataflow/observability/metrics';
import { Logger, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as NestPinoLogger } from 'nestjs-pino';

import type { AppConfig } from '#config/env.js';
import { HealthRegistry, mountHealthRoutes } from '#shared/observability/health.module.js';

import { AppModule } from './app.module.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';
import type { ShutdownProcess, ShutdownSignal } from './graceful-shutdown.js';

/** Prefixo de todas as rotas de negócio (api.md §1.1); `/health/*` e `/metrics` ficam fora (US-085). */
export const API_PREFIX = 'api/v1';

/**
 * Rotas internas BFF → API (`/internal/*` — US-087) ficam fora de `/api/v1`: o proxy do BFF só
 * encaminha `/api/v1/*`, então o navegador nunca as alcança.
 */
export const INTERNAL_ROUTES = { path: 'internal/{*path}', method: RequestMethod.ALL };

export interface StartApiOptions {
  readonly config: AppConfig;
  /** Sobrescreve a porta da configuração (`0` = porta livre, nos testes). */
  readonly port?: number;
  /** Sobrescreve a porta interna de `/metrics` (`0` = porta livre, nos testes). */
  readonly metricsPort?: number;
  /** Processo observado para SIGTERM/SIGINT (padrão: `process`). */
  readonly proc?: ShutdownProcess;
  /** `false` silencia o logger do Nest (testes). */
  readonly logger?: false;
  /** Logger pino raiz (padrão: stdout, conforme a configuração — RN-FND-71). */
  readonly rootLogger?: PinoLogger;
}

export interface RunningApi {
  readonly app: INestApplication;
  /** Porta interna efetiva de `/metrics` (HLT-03). */
  readonly metricsPort: number;
  /** Resolvida após o encerramento limpo disparado por sinal. */
  readonly stopped: Promise<ShutdownSignal>;
}

/**
 * Ajustes da aplicação HTTP comuns ao bootstrap e aos testes. `/health/live` e `/health/ready`
 * (US-085) são montados antes do pipeline; `/metrics` NÃO existe na porta pública (V-03).
 */
export function configureApiApp(app: INestApplication): INestApplication {
  mountHealthRoutes(app);
  app.setGlobalPrefix(API_PREFIX, { exclude: [INTERNAL_ROUTES] });
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

/**
 * Sobe a API, o `/metrics` na porta interna `METRICS_PORT` (HLT-03 — o provedor de métricas já foi
 * instalado pelo `otel.ts`; aqui é reaproveitado) e registra o encerramento limpo em SIGTERM/SIGINT.
 */
export async function startApi(options: StartApiOptions): Promise<RunningApi> {
  const app = await createApiApp(options);
  const port = options.port ?? options.config.port;
  await app.listen(port);
  const metricsServer = await startMetricsServer({
    handle: installMetrics({
      serviceName: 'contrataflow-api',
      serviceVersion: options.config.observability.version,
      environment: options.config.appEnv,
    }),
    port: options.metricsPort ?? options.config.metrics.port,
  });
  // `cf_health_ready`/`cf_health_check_status` (A04): readiness também como métrica.
  observeReadiness(app.get(HealthRegistry).readiness);
  const logger = new Logger('Bootstrap');
  logger.log({ event: 'api.started', port, metricsPort: metricsServer.port }, 'api started');
  const stopped = registerGracefulShutdown(
    {
      close: async () => {
        await metricsServer.close();
        await app.close();
      },
    },
    { name: 'api', logger, ...(options.proc ? { proc: options.proc } : {}) },
  );
  return { app, metricsPort: metricsServer.port, stopped };
}
