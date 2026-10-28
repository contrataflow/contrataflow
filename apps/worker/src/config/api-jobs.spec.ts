import { describe, expect, it } from 'vitest';

import { ApiJobsConfigError, loadApiJobsConfig } from './api-jobs.js';

const BASE = {
  DATABASE_URL: 'postgresql://cf_app:devpassword@localhost:5432/contrataflow',
  REDIS_CACHE_URL: 'redis://localhost:6380',
};

describe('loadApiJobsConfig (DEC-052)', () => {
  it('sem DATABASE_URL em local, os jobs da API ficam desligados', () => {
    expect(loadApiJobsConfig({})).toBeNull();
    expect(loadApiJobsConfig({ APP_ENV: 'test', DATABASE_URL: ' ' })).toBeNull();
  });

  it('fora de local/dev/test, DATABASE_URL é obrigatória', () => {
    expect(() => loadApiJobsConfig({ APP_ENV: 'staging' })).toThrow(ApiJobsConfigError);
  });

  it('não exige as variáveis só de HTTP da API e pausa o que não está configurado', () => {
    const config = loadApiJobsConfig(BASE);
    expect(config?.oidc.fakeSigningKey).toBeNull();
    expect(config?.pdf).toBeNull();
    expect(config?.antivirus).toBeNull();
    expect(config?.storage.s3).toBeNull();
  });

  it('variável inválida → erro com as chaves (nunca os valores)', () => {
    let caught: unknown;
    try {
      loadApiJobsConfig({ ...BASE, GOTENBERG_URL: 'não-é-url' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiJobsConfigError);
    expect((caught as ApiJobsConfigError).keys).toEqual(['GOTENBERG_URL']);
  });
});
