import type { IdempotencyRecord, IdempotencyStorePort } from './idempotency.js';

/** Armazenamento em memória (testes e processo único); a produção usa `RedisIdempotencyStore`. */
export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  private readonly records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  begin(key: string, bodyHash: string, ttlMs: number): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(key);
    if (existing && existing.expiresAt > Date.now()) return Promise.resolve(existing.record);
    this.records.set(key, {
      record: { state: 'IN_PROGRESS', bodyHash },
      expiresAt: Date.now() + ttlMs,
    });
    return Promise.resolve(null);
  }

  complete(
    key: string,
    record: IdempotencyRecord & { state: 'DONE' },
    ttlMs: number,
  ): Promise<void> {
    this.records.set(key, { record, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}
