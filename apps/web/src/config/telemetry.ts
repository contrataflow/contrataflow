import { loadTelemetryConfig } from '@contrataflow/observability';
import type { TelemetryConfig } from '@contrataflow/observability';

/*
 * Observabilidade do web/BFF (story US-084 — Campos): `APP_ENV`, `LOG_LEVEL`, `APP_VERSION`,
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER_ARG`. Inválidas →
 * `TelemetryConfigError` com as chaves (V-03: `debug`/`trace` em produção impedem o boot).
 */
export function webTelemetryConfig(): TelemetryConfig {
  return loadTelemetryConfig('web', process.env);
}
