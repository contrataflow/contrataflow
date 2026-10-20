import { describe, expect, it } from 'vitest';

import { HealthConfigError, loadHealthConfig, loadHealthConfigFromProcess } from './health.js';

describe('configuração de health/métricas do worker (US-085)', () => {
  it('padrões: porta interna 9465, cache de 5 s e timeout por dependência', () => {
    expect(loadHealthConfig({})).toEqual({
      metricsPort: 9465,
      cacheTtlMs: 5_000,
      checkTimeoutMs: null,
    });
    expect(loadHealthConfigFromProcess().cacheTtlMs).toBeGreaterThan(0);
  });

  it('aceita valores válidos e recusa os inválidos listando as chaves', () => {
    expect(
      loadHealthConfig({
        METRICS_PORT: '9999',
        HEALTH_CACHE_TTL_MS: '1000',
        HEALTH_CHECK_TIMEOUT_MS: '300',
      }),
    ).toEqual({ metricsPort: 9999, cacheTtlMs: 1_000, checkTimeoutMs: 300 });
    expect(() => loadHealthConfig({ METRICS_PORT: '0', HEALTH_CACHE_TTL_MS: '-1' })).toThrow(
      HealthConfigError,
    );
    try {
      loadHealthConfig({ METRICS_PORT: '70000' });
    } catch (error) {
      expect((error as HealthConfigError).keys).toEqual(['METRICS_PORT']);
    }
  });
});
