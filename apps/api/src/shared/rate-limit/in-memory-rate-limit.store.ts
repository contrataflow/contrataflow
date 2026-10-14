import type { RateLimitStorePort } from './rate-limit.js';

/** Armazenamento em memória (testes e processo único); a produção usa `RedisThrottlerStorage`. */
export class InMemoryRateLimitStore implements RateLimitStorePort {
  private readonly counters = new Map<string, number>();

  increment(baseKey: string, windowIndex: number): Promise<{ current: number; previous: number }> {
    const currentKey = `${baseKey}:${windowIndex}`;
    const current = (this.counters.get(currentKey) ?? 0) + 1;
    this.counters.set(currentKey, current);
    this.counters.delete(`${baseKey}:${windowIndex - 2}`);
    return Promise.resolve({
      current,
      previous: this.counters.get(`${baseKey}:${windowIndex - 1}`) ?? 0,
    });
  }

  reset(): void {
    this.counters.clear();
  }
}
