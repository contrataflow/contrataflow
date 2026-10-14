import { loadTelemetryConfig } from '@contrataflow/observability';
import type { TelemetryConfig } from '@contrataflow/observability';

/**
 * Variáveis de observabilidade lidas pelo `otel.ts` antes da aplicação (story US-084 — Campos):
 * `LOG_LEVEL`, `APP_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` e
 * `OTEL_TRACES_SAMPLER_ARG`. Inválidas → `TelemetryConfigError` com as chaves.
 */
export function loadTelemetryConfigFromProcess(): TelemetryConfig {
  return loadTelemetryConfig('api', process.env);
}
