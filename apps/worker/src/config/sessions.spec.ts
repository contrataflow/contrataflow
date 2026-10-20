import { describe, expect, it, vi } from 'vitest';

import {
  SessionsConfigError,
  loadSessionsConfig,
  loadSessionsConfigFromProcess,
} from './sessions.js';

const SESSIONS = 'rediss://sessions.internal:6379';

function failureOf(env: Record<string, string | undefined>): unknown {
  try {
    loadSessionsConfig(env);
  } catch (caught) {
    return caught;
  }
  return null;
}

describe('configuração do Redis de sessões no worker (US-088 · RN-IAM-27)', () => {
  it('lê a URL do Redis de sessões', () => {
    expect(loadSessionsConfig({ APP_ENV: 'staging', REDIS_SESSION_URL: SESSIONS })).toEqual({
      appEnv: 'staging',
      redisUrl: SESSIONS,
    });
    expect(loadSessionsConfig({ REDIS_SESSION_URL: 'redis://localhost:6379' })).toEqual({
      appEnv: 'local',
      redisUrl: 'redis://localhost:6379',
    });
  });

  it('em local/dev/test, ausente ou em branco, o consumidor fica desligado', () => {
    expect(loadSessionsConfig({})).toBeNull();
    expect(loadSessionsConfig({ APP_ENV: 'test' })).toBeNull();
    expect(loadSessionsConfig({ APP_ENV: 'dev', REDIS_SESSION_URL: '  ' })).toBeNull();
  });

  it('em staging/production a URL é obrigatória (só o nome da chave no erro)', () => {
    expect(() => loadSessionsConfig({ APP_ENV: 'production' })).toThrow(
      new SessionsConfigError(['REDIS_SESSION_URL']),
    );
    expect(() => loadSessionsConfig({ APP_ENV: 'staging', REDIS_SESSION_URL: '' })).toThrow(
      /REDIS_SESSION_URL/,
    );
  });

  it('recusa protocolo errado ou ambiente desconhecido sem vazar a URL', () => {
    const error = failureOf({
      APP_ENV: 'qa',
      REDIS_SESSION_URL: 'http://usuario:segredo@sessions.internal',
    });
    expect(error).toBeInstanceOf(SessionsConfigError);
    expect((error as SessionsConfigError).keys).toEqual(['APP_ENV', 'REDIS_SESSION_URL']);
    expect((error as SessionsConfigError).message).not.toContain('segredo');
  });

  it('lê do process.env', () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('REDIS_SESSION_URL', SESSIONS);
    try {
      expect(loadSessionsConfigFromProcess()).toEqual({
        appEnv: 'production',
        redisUrl: SESSIONS,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
