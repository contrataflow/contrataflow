import 'server-only';

import type { NodeSDK } from '@contrataflow/observability/telemetry';
import { createTelemetrySdk, isIgnoredHttpPath } from '@contrataflow/observability/telemetry';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

import { webTelemetryConfig } from '@/config/telemetry';

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
