import { register } from 'node:module';

import { TelemetryConfigError, createLogger } from '@contrataflow/observability';
import { installMetrics } from '@contrataflow/observability/metrics';
import { createTelemetrySdk, isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PrismaInstrumentation } from '@prisma/instrumentation';

import { loadTelemetryConfigFromProcess } from '#config/telemetry.js';

/*
 * OpenTelemetry Node SDK da API (RN-FND-75 · observability.md §4.1), carregado ANTES da aplicação:
 * `node --import ./dist/otel.js dist/main.js`. Nenhuma instrumentação captura corpo, query string,
 * cabeçalhos (exceto `x-correlation-id`) nem parâmetros SQL; o ioredis registra só o comando.
 */

function start(): void {
  let config;
  try {
    config = loadTelemetryConfigFromProcess();
  } catch (error) {
    if (!(error instanceof TelemetryConfigError)) throw error;
    // V-03: LOG_LEVEL proibido (ou telemetria inválida) impede o processo de subir.
    createLogger({ service: 'api', env: 'unknown', version: 'unknown', level: 'info' }).fatal(
      { event: 'api.config_invalid', keys: error.keys },
      'invalid configuration',
    );
    process.exit(1);
  }

  const logger = createLogger({
    service: 'api',
    env: config.environment,
    version: config.version,
    level: config.logLevel,
  });
  // Métricas (US-085) independem do Collector: o provedor global existe antes de qualquer
  // `metrics.getMeter()` da aplicação e é servido em `/metrics` na porta interna pelo bootstrap.
  installMetrics({
    serviceName: config.serviceName,
    serviceVersion: config.version,
    environment: config.environment,
  });
  if (!config.endpoint) {
    logger.warn({ event: 'tracing.disabled', reason: 'endpoint_missing' }, 'tracing disabled');
    return;
  }

  // Módulos ESM da aplicação passam pelo hook das instrumentações (import-in-the-middle). O hook
  // é assíncrono: `module.registerHooks()` (síncrono) ainda não o suporta.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- ver comentário acima
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const sdk = createTelemetrySdk({
    serviceName: config.serviceName,
    serviceVersion: config.version,
    environment: config.environment,
    endpoint: config.endpoint,
    samplerRatio: config.samplerRatio,
    logger,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => isIgnoredHttpPath(request.url),
        headersToSpanAttributes: { server: { requestHeaders: ['x-correlation-id'] } },
      }),
      new UndiciInstrumentation(),
      new NestInstrumentation(),
      new PrismaInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    ],
  });
  sdk.start();
  process.once('beforeExit', () => {
    void sdk.shutdown();
  });
}

start();
