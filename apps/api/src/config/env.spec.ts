import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadConfig } from '#config/env.js';

const REQUIRED = {
  REDIS_CACHE_URL: 'redis://localhost:6380',
  OIDC_ISSUER_URL: 'http://localhost:9080/application/o/contrataflow/',
};

describe('loadConfig', () => {
  it('aplica os padrões da story (Campos) e congela o resultado', () => {
    const config = loadConfig(REQUIRED);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      appEnv: 'local',
      port: 4000,
      oidc: { audiences: ['contrataflow-api'], clockToleranceSeconds: 30 },
      http: { correlationHeader: 'X-Correlation-Id' },
      pagination: { maxPageSize: 100 },
      rateLimit: {
        windowMs: 60_000,
        perClass: { read: 600, write: 120, autosave: 60, export: 20, upload: 60 },
        perTenant: 6000,
      },
      idempotency: { ttlMs: 24 * 3_600_000 },
    });
    expect(Object.isFrozen(config.rateLimit.perClass)).toBe(true);
  });

  it('converte números e separa audiências por vírgula', () => {
    const config = loadConfig({
      ...REQUIRED,
      PORT: '8080',
      OIDC_AUDIENCE: 'contrataflow-api, contrataflow-web',
      RATE_LIMIT_READ_PER_MIN: '5',
      IDEMPOTENCY_TTL_HOURS: '1',
    });
    expect(config.port).toBe(8080);
    expect(config.oidc.audiences).toEqual(['contrataflow-api', 'contrataflow-web']);
    expect(config.rateLimit.perClass.read).toBe(5);
    expect(config.idempotency.ttlMs).toBe(3_600_000);
  });

  it('V-01: recusa variável ausente ou inválida apontando as chaves, sem os valores', () => {
    const attempt = () =>
      loadConfig({ REDIS_CACHE_URL: 'http://segredo@host', PORT: '70000', NODE_ENV: 'prod' });
    expect(attempt).toThrow(ConfigValidationError);
    try {
      attempt();
    } catch (error) {
      const failure = error as ConfigValidationError;
      expect(failure.keys).toEqual(['NODE_ENV', 'OIDC_ISSUER_URL', 'PORT', 'REDIS_CACHE_URL']);
      expect(failure.message).not.toContain('segredo');
    }
  });

  it('o cabeçalho de correlação é fixo por contrato e o tamanho de página vai de 1 a 100', () => {
    expect(() => loadConfig({ ...REQUIRED, CORRELATION_HEADER_NAME: 'X-Request-Id' })).toThrow(
      /CORRELATION_HEADER_NAME/,
    );
    expect(() => loadConfig({ ...REQUIRED, PAGINATION_MAX_PAGE_SIZE: '101' })).toThrow(
      /PAGINATION_MAX_PAGE_SIZE/,
    );
  });
});
