import { describe, expect, it, vi } from 'vitest';

import {
  AuthRateLimiter,
  MemoryRateLimitCounter,
  RedisRateLimitCounter,
} from '@/bff/auth/rate-limit';

/* RN-IAM-15: 20 req/min por IP nas rotas de login, janela fixa de 1 min. */

const START = Date.parse('2026-10-14T12:00:00Z');

describe('AuthRateLimiter', () => {
  it('permite até o limite por IP e janela; acima → Retry-After até o fim da janela', async () => {
    const clock = { now: START + 15_000 };
    const limiter = new AuthRateLimiter(new MemoryRateLimitCounter(), {
      limit: 20,
      keyPrefix: 'cf:test:rl:auth:',
      now: () => clock.now,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await limiter.check('203.0.113.7')).toEqual({ allowed: true });
    }
    expect(await limiter.check('203.0.113.7')).toEqual({ allowed: false, retryAfterSeconds: 45 });
    // Outro IP não é afetado; nova janela zera o contador.
    expect(await limiter.check('198.51.100.1')).toEqual({ allowed: true });
    clock.now = START + 60_000;
    expect(await limiter.check('203.0.113.7')).toEqual({ allowed: true });
  });

  it('sem IP conhecido não limita; contador fora do ar → falha aberta com aviso', async () => {
    const onError = vi.fn();
    const limiter = new AuthRateLimiter(
      {
        hit: () => Promise.reject(new Error('redis fora')),
        peek: () => Promise.reject(new Error('redis fora')),
      },
      { limit: 1, keyPrefix: 'p:', onError },
    );
    expect(await limiter.check(null)).toEqual({ allowed: true });
    expect(await limiter.check('203.0.113.7')).toEqual({ allowed: true });
    expect(await limiter.peek('u')).toEqual({ allowed: true });
    await limiter.record('u');
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('limite de falhas (DEC-187): peek não conta; record conta; bloqueia ao atingir o limite', async () => {
    const clock = { now: START };
    const limiter = new AuthRateLimiter(new MemoryRateLimitCounter(), {
      limit: 2,
      windowMs: 15 * 60_000,
      keyPrefix: 'cf:test:rl:login-user:',
      now: () => clock.now,
    });
    expect(await limiter.peek('u1')).toEqual({ allowed: true });
    expect(await limiter.peek('u1')).toEqual({ allowed: true });
    await limiter.record('u1');
    expect(await limiter.peek('u1')).toEqual({ allowed: true });
    await limiter.record('u1');
    const blocked = await limiter.peek('u1');
    expect(blocked.allowed).toBe(false);
    expect(await limiter.peek('u2')).toEqual({ allowed: true });
    clock.now += 15 * 60_000;
    expect(await limiter.peek('u1')).toEqual({ allowed: true });
  });

  it('contador do Redis: INCR e expiração só na primeira batida da janela', async () => {
    const redis = {
      incr: vi.fn(),
      pexpire: vi.fn(() => Promise.resolve(1)),
      get: vi.fn<(key: string) => Promise<string | null>>(),
    };
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const counter = new RedisRateLimitCounter(redis);
    expect(await counter.hit('k', 60_000)).toBe(1);
    expect(await counter.hit('k', 60_000)).toBe(2);
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
    expect(redis.pexpire).toHaveBeenCalledWith('k', 60_000);
    redis.get.mockResolvedValueOnce('2').mockResolvedValueOnce(null);
    expect(await counter.peek('k')).toBe(2);
    expect(await counter.peek('k')).toBe(0);
  });
});
