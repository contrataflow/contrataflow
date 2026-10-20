import { register } from 'node:module';

import { TelemetryConfigError } from '@contrataflow/observability';
import { installMetrics } from '@contrataflow/observability/metrics';
import { createTelemetrySdk } from '@contrataflow/observability/telemetry';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

import { loadTelemetryConfigFromProcess } from './config/telemetry.js';
import { createWorkerLogger } from './observability/worker-logger.js';

/*
 * OpenTelemetry Node SDK do worker (RN-FND-75 · observability.md §4.1), carregado ANTES da
 * aplicação: `node --import ./dist/otel.js dist/main.js`. Spans de cliente para S3, Gotenberg,
 * clamd e SMTP vêm das instrumentações HTTP/undici; BullMQ propaga pelo `JobMeta` (US-083).
 */

function start(): void {
  let config;
  try {
    config = loadTelemetryConfigFromProcess();
  } catch (error) {
    // Configuração inválida: o `main.ts` registra `worker.config_invalid` e encerra (V-03).
    if (error instanceof TelemetryConfigError) return;
    throw error;
  }
  const logger = createWorkerLogger(config);
  // Métricas (US-085) independem do Collector: provedor global antes de qualquer `getMeter()`.
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
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
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
