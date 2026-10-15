import { Redis } from 'ioredis';

/*
 * Redis do worker para os efeitos leves do fan-out (US-082 · DEC-072): único ponto do worker com
 * cliente Redis (RM-03 — lint `contrataflow/no-direct-redis`). Toda chave é montada aqui com o
 * escopo do tenant do evento — `cf:{env}:t:{tenantId}:…`, ou `cf:{env}:p:…` para evento de
 * plataforma — e todo valor gravado tem TTL (architecture.md §6.12).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface TenantRedisCacheOptions {
  readonly redisUrl: string;
  readonly appEnv: string;
}

/** Escopo da chave inválido (tenant que não é UUID, segmento com `:`/`*`): erro de programação. */
export class CacheKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheKeyError';
  }
}

export class TenantRedisCache {
  readonly redis: Redis;

  constructor(private readonly options: TenantRedisCacheOptions) {
    this.redis = new Redis(options.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // Queda do Redis: os comandos falham e o job do fan-out é repetido pela fila.
    this.redis.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }

  /** `cf:{env}:t:{tenantId}:<segmentos>` (ou `cf:{env}:p:…` sem tenant). */
  key(tenantId: string | null, segments: readonly string[]): string {
    if (tenantId !== null && !UUID.test(tenantId)) {
      throw new CacheKeyError('tenantId inválido para chave de cache');
    }
    for (const segment of segments) {
      if (!SEGMENT.test(segment)) throw new CacheKeyError(`segmento de chave inválido: ${segment}`);
    }
    const scope = tenantId === null ? 'p' : `t:${tenantId}`;
    return [`cf:${this.options.appEnv}`, scope, ...segments].join(':');
  }

  /** `SET NX EX`: `true` só na primeira vez dentro do TTL (deduplicação por `eventId`). */
  async setOnce(
    tenantId: string | null,
    segments: readonly string[],
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.set(this.key(tenantId, segments), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async delete(tenantId: string, segments: readonly string[]): Promise<number> {
    return this.redis.del(this.key(tenantId, segments));
  }

  /** Apaga todas as chaves do tenant sob o prefixo (`SCAN` incremental, nunca `KEYS`). */
  async deleteByPrefix(tenantId: string, segments: readonly string[]): Promise<number> {
    const pattern = `${this.key(tenantId, segments)}:*`;
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) deleted += await this.redis.unlink(...keys);
    } while (cursor !== '0');
    return deleted;
  }

  close(): void {
    this.redis.disconnect();
  }
}
