import 'server-only';

import {
  installMetrics,
  observeReadiness,
  startMetricsServer,
} from '@contrataflow/observability/metrics';
import type { NodeSDK } from '@contrataflow/observability/telemetry';
import { createTelemetrySdk, isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

import { webHealthConfig } from '@/config/health';
import { webTelemetryConfig } from '@/config/telemetry';

import { bffHealth } from './health';
import { bffLogger } from './logger';

/*
 * OpenTelemetry Node SDK do BFF (RN-FND-75/76 · observability.md §4.1–§4.2), iniciado pelo
 * `instrumentation.ts` antes de qualquer requisição. O Next abre o span raiz de cada requisição
 * (sem instrumentação de browser no MVP 1); o `fetch` do BFF → API passa pelo undici
 * instrumentado, que injeta o `traceparent` (W3C, sem baggage).
 */
export function startWebTelemetry(): NodeSDK | null {
  const config = webTelemetryConfig();
  const logger = bffLogger();
  startWebMetrics();
  if (!config.endpoint) {
    logger.warn({ event: 'tracing.disabled', reason: 'endpoint_missing' }, 'tracing disabled');
    return null;
  }
  const sdk = createTelemetrySdk({
    serviceName: config.serviceName,
    serviceVersion: config.version,
    environment: config.environment,
    endpoint: config.endpoint,
    samplerRatio: config.samplerRatio,
    logger,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          isIgnoredHttpPath(request.url) || (request.url ?? '').startsWith('/_next/'),
        headersToSpanAttributes: { server: { requestHeaders: ['x-correlation-id'] } },
      }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}

// Em globalThis: o `register()` do Next pode rodar de novo no mesmo processo (HMR do `next dev`).
const globalMetrics = globalThis as typeof globalThis & { __contrataflowMetricsServer?: boolean };

/**
 * Métricas do BFF (US-085 · HLT-03): provedor global do OpenTelemetry e `/metrics` SOMENTE na
 * porta interna `METRICS_PORT` — o servidor do Next (porta pública) não tem rota `/metrics`.
 */
export function startWebMetrics(): void {
  const config = webTelemetryConfig();
  const handle = installMetrics({
    serviceName: config.serviceName,
    serviceVersion: config.version,
    environment: config.environment,
  });
  if (globalMetrics.__contrataflowMetricsServer) return;
  globalMetrics.__contrataflowMetricsServer = true;
  // Readiness como métrica (A04); as sondas só são montadas na primeira coleta.
  observeReadiness({ check: () => bffHealth().readiness.check() });
  startMetricsServer({ handle, port: webHealthConfig().metricsPort }).catch((error: unknown) => {
    globalMetrics.__contrataflowMetricsServer = false;
    bffLogger().warn(
      {
        event: 'metrics.server_failed',
        errorType: error instanceof Error ? error.name : 'unknown',
      },
      'metrics server failed',
    );
  });
}
