import { describe, expect, it, vi } from 'vitest';

import { OutboxConfigError, loadOutboxConfig, loadOutboxConfigFromProcess } from './outbox.js';

const RELAY = 'postgresql://cf_relay:x@localhost:5432/contrataflow';
const REDIS = 'redis://localhost:6380';

describe('configuração do outbox no worker (US-082)', () => {
  it('lê as URLs do relay e do Redis das filas', () => {
    expect(
      loadOutboxConfig({ APP_ENV: 'staging', DATABASE_URL_RELAY: RELAY, REDIS_URL: REDIS }),
    ).toEqual({ appEnv: 'staging', relayDatabaseUrl: RELAY, redisUrl: REDIS });
  });

  it('em local/dev/test, sem as duas variáveis, o relay fica desligado', () => {
    expect(loadOutboxConfig({})).toBeNull();
    expect(
      loadOutboxConfig({ APP_ENV: 'test', DATABASE_URL_RELAY: ' ', REDIS_URL: '' }),
    ).toBeNull();
  });

  it('exige as duas fora de local/dev/test e recusa configuração pela metade', () => {
    expect(() => loadOutboxConfig({ APP_ENV: 'production' })).toThrow(
      new OutboxConfigError(['DATABASE_URL_RELAY', 'REDIS_URL']),
    );
    expect(() => loadOutboxConfig({ APP_ENV: 'local', REDIS_URL: REDIS })).toThrow(
      /DATABASE_URL_RELAY/,
    );
  });

  it('recusa URL com protocolo errado ou ambiente desconhecido (só os nomes das chaves)', () => {
    const error = (() => {
      try {
        loadOutboxConfig({ APP_ENV: 'qa', DATABASE_URL_RELAY: REDIS, REDIS_URL: RELAY });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(OutboxConfigError);
    expect((error as OutboxConfigError).keys).toEqual([
      'APP_ENV',
      'DATABASE_URL_RELAY',
      'REDIS_URL',
    ]);
  });

  it('lê do process.env', () => {
    vi.stubEnv('APP_ENV', 'dev');
    vi.stubEnv('DATABASE_URL_RELAY', RELAY);
    vi.stubEnv('REDIS_URL', REDIS);
    try {
      expect(loadOutboxConfigFromProcess()).toEqual({
        appEnv: 'dev',
        relayDatabaseUrl: RELAY,
        redisUrl: REDIS,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
