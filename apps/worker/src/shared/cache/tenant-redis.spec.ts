import { afterEach, describe, expect, it } from 'vitest';

import { CacheKeyError, TenantRedisCache } from './tenant-redis.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';

describe('TenantRedisCache — chaves por tenant (RM-03)', () => {
  const cache = new TenantRedisCache({ redisUrl: 'redis://127.0.0.1:1', appEnv: 'test' });

  afterEach(() => {
    cache.close();
  });

  it('monta cf:{env}:t:{tenantId}:… ou cf:{env}:p:… para plataforma', () => {
    expect(cache.key(TENANT, ['access', 'eff', 'm1'])).toBe(`cf:test:t:${TENANT}:access:eff:m1`);
    expect(cache.key(null, ['evt', 'X', 'e1'])).toBe('cf:test:p:evt:X:e1');
  });

  it('recusa tenant que não é UUID e segmento que escaparia do escopo', () => {
    expect(() => cache.key('*', ['a'])).toThrow(CacheKeyError);
    expect(() => cache.key(TENANT, ['a:b'])).toThrow(/segmento/);
    expect(() => cache.key(TENANT, ['*'])).toThrow(/segmento/);
  });

  it('com o Redis fora, os comandos falham em vez de enfileirar', async () => {
    await expect(cache.setOnce(TENANT, ['evt', 'X', 'e1'], 60)).rejects.toThrow();
  });
});
