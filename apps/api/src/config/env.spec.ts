import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadConfig } from '#config/env.js';

const REQUIRED = {
  DATABASE_URL: 'postgresql://cf_app:devpassword@localhost:5432/contrataflow',
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
      database: {
        poolSize: 10,
        maxWaitMs: 2_000,
        transactionTimeoutMs: 10_000,
        statementTimeoutMs: 5_000,
      },
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

  it('US-087: identidade fake só em local/dev/test e credencial interna obrigatória fora deles', () => {
    const fake = 'x'.repeat(32);
    expect(loadConfig({ ...REQUIRED, OIDC_FAKE_SIGNING_KEY: fake }).oidc.fakeSigningKey).toBe(fake);
    expect(() =>
      loadConfig({
        ...REQUIRED,
        APP_ENV: 'production',
        OIDC_FAKE_SIGNING_KEY: fake,
        INTERNAL_SERVICE_TOKEN: 'y'.repeat(32),
      }),
    ).toThrow(/OIDC_FAKE_SIGNING_KEY/);
    expect(() => loadConfig({ ...REQUIRED, APP_ENV: 'staging' })).toThrow(/INTERNAL_SERVICE_TOKEN/);
    const staging = loadConfig({
      ...REQUIRED,
      APP_ENV: 'staging',
      INTERNAL_SERVICE_TOKEN: 'y'.repeat(32),
      AUTHENTIK_API_URL: 'https://auth.contrataflow.test/api/v3/',
      AUTHENTIK_API_TOKEN: 'z'.repeat(16),
    });
    expect(staging.internal.serviceToken).toBe('y'.repeat(32));
    expect(staging.authentik).toEqual({
      apiUrl: 'https://auth.contrataflow.test/api/v3/',
      apiToken: 'z'.repeat(16),
    });
    expect(loadConfig(REQUIRED).authentik).toBeNull();
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
      expect(failure.keys).toEqual([
        'DATABASE_URL',
        'NODE_ENV',
        'OIDC_ISSUER_URL',
        'PORT',
        'REDIS_CACHE_URL',
      ]);
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

  it('observabilidade: LOG_LEVEL padrão info e APP_VERSION informada (US-084)', () => {
    expect(loadConfig(REQUIRED).observability).toEqual({
      logLevel: 'info',
      version: '0.0.0+local',
    });
    expect(
      loadConfig({ ...REQUIRED, LOG_LEVEL: 'debug', APP_VERSION: '1.4.2+g3f9c2ab' }).observability,
    ).toEqual({ logLevel: 'debug', version: '1.4.2+g3f9c2ab' });
  });

  it.each(['debug', 'trace'])('V-03: LOG_LEVEL=%s em produção impede o boot', (level) => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: 'production', LOG_LEVEL: level })).toThrow(
      expect.objectContaining({ keys: ['LOG_LEVEL'] }),
    );
    expect(
      loadConfig({ ...REQUIRED, NODE_ENV: 'production', LOG_LEVEL: 'warn' }).observability.logLevel,
    ).toBe('warn');
  });
});
