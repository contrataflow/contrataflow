import { Injectable } from '@nestjs/common';

import type { CacheStore } from '#shared/cache/cache-store.js';

import { RedisClient } from './redis.client.js';

/**
 * `CacheStore` sobre o Redis principal (US-100): as chaves chegam prontas do `TenantCache` /
 * `PlatformCache` (`cf:{env}:t:{tenantId}:…` ou `cf:{env}:p:…`). Sem fila offline: com o Redis fora,
 * o comando falha na hora e quem chamou degrada (lê do banco).
 */
@Injectable()
export class RedisCacheStore implements CacheStore {
  constructor(private readonly client: RedisClient) {}

  get(key: string): Promise<string | null> {
    return this.client.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.redis.set(key, value, 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.redis.del(key);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  getMany(keys: readonly string[]): Promise<(string | null)[]> {
    return keys.length === 0 ? Promise.resolve([]) : this.client.redis.mget(...keys);
  }
}
