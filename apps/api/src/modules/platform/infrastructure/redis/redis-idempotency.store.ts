import { Injectable } from '@nestjs/common';

import type { IdempotencyRecord, IdempotencyStorePort } from '#shared/idempotency/idempotency.js';

import { RedisClient } from './redis.client.js';

/** Registros de idempotência no Redis (RN-FND-35 · architecture.md §6.10). */
@Injectable()
export class RedisIdempotencyStore implements IdempotencyStorePort {
  constructor(private readonly client: RedisClient) {}

  async begin(key: string, bodyHash: string, ttlMs: number): Promise<IdempotencyRecord | null> {
    const reserving: IdempotencyRecord = { state: 'IN_PROGRESS', bodyHash };
    // Duas tentativas: o registro existente pode expirar entre o SET NX e o GET.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reserved = await this.client.redis.set(
        key,
        JSON.stringify(reserving),
        'PX',
        ttlMs,
        'NX',
      );
      if (reserved === 'OK') return null;
      const existing = await this.client.redis.get(key);
      if (existing !== null) return JSON.parse(existing) as IdempotencyRecord;
    }
    return null;
  }

  async complete(key: string, record: IdempotencyRecord & { state: 'DONE' }, ttlMs: number) {
    await this.client.redis.set(key, JSON.stringify(record), 'PX', ttlMs);
  }

  async release(key: string): Promise<void> {
    await this.client.redis.del(key);
  }
}
