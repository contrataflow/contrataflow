import { loadTelemetryConfig } from '@contrataflow/observability';
import type { TelemetryConfig } from '@contrataflow/observability';

/**
 * Variáveis de observabilidade do worker (story US-084 — Campos): `APP_ENV`, `LOG_LEVEL`,
 * `APP_VERSION`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG`.
 * Único ponto do worker que lê `process.env` (RN-FND-06); inválidas → `TelemetryConfigError`.
 */
export function loadTelemetryConfigFromProcess(): TelemetryConfig {
  return loadTelemetryConfig('worker', process.env);
}
