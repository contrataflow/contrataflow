import { describe, expect, it } from 'vitest';

import { TelemetryConfigError, loadTelemetryConfig } from './telemetry-config.js';

function keysOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof TelemetryConfigError) return error.keys;
    throw error;
  }
  return [];
}

describe('loadTelemetryConfig (story US-084 — Campos)', () => {
  it('aplica os padrões fora de staging/produção', () => {
    expect(loadTelemetryConfig('api', {})).toEqual({
      service: 'api',
      serviceName: 'contrataflow-api',
      environment: 'local',
      production: false,
      version: '0.0.0+local',
      logLevel: 'info',
      endpoint: null,
      samplerRatio: 1,
    });
  });

  it('lê as variáveis informadas', () => {
    expect(
      loadTelemetryConfig('worker', {
        APP_ENV: 'staging',
        NODE_ENV: 'production',
        APP_VERSION: '1.4.2+g3f9c2ab',
        LOG_LEVEL: 'warn',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
        OTEL_SERVICE_NAME: 'contrataflow-worker',
        OTEL_TRACES_SAMPLER_ARG: '0.1',
      }),
    ).toMatchObject({
      serviceName: 'contrataflow-worker',
      environment: 'staging',
      production: true,
      version: '1.4.2+g3f9c2ab',
      logLevel: 'warn',
      endpoint: 'http://otel-collector:4318',
      samplerRatio: 0.1,
    });
  });

  it.each(['debug', 'trace'])('V-03: LOG_LEVEL=%s em produção impede o boot', (level) => {
    expect(
      keysOf(() => loadTelemetryConfig('api', { NODE_ENV: 'production', LOG_LEVEL: level })),
    ).toEqual(['LOG_LEVEL']);
    expect(loadTelemetryConfig('api', { LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('lista todas as chaves inválidas, nunca os valores', () => {
    const keys = keysOf(() =>
      loadTelemetryConfig('web', {
        APP_ENV: 'production',
        LOG_LEVEL: 'verbose',
        OTEL_SERVICE_NAME: 'outro',
        OTEL_TRACES_SAMPLER_ARG: '2',
      }),
    );
    expect(keys).toEqual([
      'LOG_LEVEL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_SERVICE_NAME',
      'OTEL_TRACES_SAMPLER_ARG',
    ]);
  });

  it('rejeita endpoint que não é URL http(s)', () => {
    expect(
      keysOf(() => loadTelemetryConfig('api', { OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://x' })),
    ).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT']);
    expect(
      keysOf(() => loadTelemetryConfig('api', { OTEL_EXPORTER_OTLP_ENDPOINT: 'nada' })),
    ).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT']);
  });
});
