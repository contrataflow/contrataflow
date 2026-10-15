import { describe, expect, it } from 'vitest';

import { QueuesConfigError, loadQueueCliConfig, loadQueuesConfig } from './queues.js';

const BASE = {
  APP_ENV: 'staging',
  REDIS_URL: 'redis://redis:6379',
  DATABASE_URL_WORKER: 'postgresql://cf_worker:x@db:5432/contrataflow',
  DATABASE_URL_MAINTENANCE: 'postgresql://cf_maintenance:x@db:5432/contrataflow',
};

function keysOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueuesConfigError) return error.keys;
    throw error;
  }
  return [];
}

describe('configuração das filas do worker', () => {
  it('local sem Redis: filas desligadas; staging exige Redis e banco', () => {
    expect(loadQueuesConfig({})).toBeNull();
    expect(keysOf(() => loadQueuesConfig({ APP_ENV: 'production' }))).toEqual(['REDIS_URL']);
    expect(keysOf(() => loadQueuesConfig({ ...BASE, DATABASE_URL_WORKER: ' ' }))).toEqual([
      'DATABASE_URL_WORKER',
    ]);
    expect(keysOf(() => loadQueuesConfig({ ...BASE, DATABASE_URL_MAINTENANCE: '' }))).toEqual([
      'DATABASE_URL_MAINTENANCE',
    ]);
    expect(keysOf(() => loadQueuesConfig({ ...BASE, REDIS_URL: 'http://x' }))).toEqual([
      'REDIS_URL',
    ]);
    expect(loadQueuesConfig({ APP_ENV: 'local', REDIS_URL: 'redis://r' })).toEqual({
      appEnv: 'local',
      redisUrl: 'redis://r',
      workerDatabaseUrl: null,
      maintenanceDatabaseUrl: null,
      admin: null,
    });
  });

  it('Bull Board só com a porta interna e, então, com o cliente OIDC de operação', () => {
    expect(loadQueuesConfig(BASE)?.admin).toBeNull();
    expect(keysOf(() => loadQueuesConfig({ ...BASE, WORKER_ADMIN_PORT: '4100' }))).toEqual([
      'OIDC_ISSUER_URL',
      'WORKER_ADMIN_OIDC_AUDIENCE',
    ]);
    expect(
      loadQueuesConfig({
        ...BASE,
        WORKER_ADMIN_PORT: '4100',
        OIDC_ISSUER_URL: 'https://auth/app/',
        WORKER_ADMIN_OIDC_AUDIENCE: 'cf-ops',
      })?.admin,
    ).toEqual({ port: 4100, issuer: 'https://auth/app/', audience: 'cf-ops' });
    expect(keysOf(() => loadQueuesConfig({ ...BASE, WORKER_ADMIN_PORT: '99999' }))).toEqual([
      'WORKER_ADMIN_PORT',
    ]);
  });

  it('CLI exige token, OIDC, Redis e banco', () => {
    expect(keysOf(() => loadQueueCliConfig({ APP_ENV: 'local' }))).toEqual([
      'REDIS_URL',
      'DATABASE_URL_WORKER',
      'CF_OPS_TOKEN',
      'OIDC_ISSUER_URL',
      'WORKER_ADMIN_OIDC_AUDIENCE',
    ]);
    const config = loadQueueCliConfig({
      ...BASE,
      CF_OPS_TOKEN: 'tok',
      OIDC_ISSUER_URL: 'https://auth/app/',
      WORKER_ADMIN_OIDC_AUDIENCE: 'cf-ops',
      DATABASE_URL_RELAY: 'postgresql://cf_relay:x@db/contrataflow',
    });
    expect(config).toMatchObject({
      token: 'tok',
      audience: 'cf-ops',
      relayDatabaseUrl: 'postgresql://cf_relay:x@db/contrataflow',
    });
    expect(
      loadQueueCliConfig({
        ...BASE,
        CF_OPS_TOKEN: 't',
        OIDC_ISSUER_URL: 'https://a/',
        WORKER_ADMIN_OIDC_AUDIENCE: 'a',
      }).relayDatabaseUrl,
    ).toBeNull();
  });
});
