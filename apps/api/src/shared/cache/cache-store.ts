/**
 * Armazenamento chave-valor do cache (US-100 · RN-TEN-29): o adaptador Redis fica no módulo
 * `platform` (único lugar com cliente Redis — lint `contrataflow/no-direct-redis`); o restante da
 * API só usa `TenantCache`/`PlatformCache`, que montam a chave. Todo valor tem TTL.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Várias chaves numa ida (`MGET`); sem implementação, o `TenantCache` lê uma a uma. */
  getMany?(keys: readonly string[]): Promise<(string | null)[]>;
}

export const CACHE_STORE = Symbol('CacheStore');

/** Cache em memória (testes e modo de identidade fake), com o mesmo TTL do Redis. */
export class InMemoryCacheStore implements CacheStore {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  async getMany(keys: readonly string[]): Promise<(string | null)[]> {
    const values: (string | null)[] = [];
    for (const key of keys) values.push(await this.get(key));
    return values;
  }
}
