import { Injectable } from '@nestjs/common';

import type { RateLimitStorePort } from '#shared/rate-limit/rate-limit.js';

import { RedisClient } from './redis.client.js';

/**
 * Incrementa o contador da janela atual (expira em 2 janelas, para servir de "anterior" na
 * seguinte) e lê o da anterior, numa única ida ao Redis (atômico).
 */
const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
return { current, previous }
`;

/** Contadores do rate limit no Redis (RN-FND-36 — janela deslizante via script Lua, §6.13). */
@Injectable()
export class RedisThrottlerStorage implements RateLimitStorePort {
  constructor(private readonly client: RedisClient) {}

  async increment(baseKey: string, windowIndex: number, windowMs: number) {
    const [current, previous] = (await this.client.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${baseKey}:${windowIndex}`,
      `${baseKey}:${windowIndex - 1}`,
      String(windowMs * 2),
    )) as [number, number];
    return { current, previous };
  }
}
