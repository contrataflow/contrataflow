import 'server-only';

import { seal, unseal } from '../crypto';
import { SessionStoreUnavailableError } from './types';
import type { SessionRecord, SessionStore, SessionTokens } from './types';

/*
 * Redis de sessões (DEC-131 · RN-IAM-10 · US-087 Lacuna 3): `cf:{env}:sess:{sha256(sid)}` guarda o
 * registro (tokens cifrados com AES-256-GCM, amarrados à chave da sessão) com TTL até o fim
 * absoluto; `cf:{env}:sess:user:{userId}` é o índice por usuário (sorted set por criação), que
 * limita as sessões simultâneas. Chaves de plataforma: nunca passam pelo `TenantCache`.
 */

/** Subconjunto do ioredis usado aqui (facilita o teste com um Redis em memória). */
export interface SessionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

export interface RedisSessionStoreOptions {
  /** `cf:{env}:sess:`. */
  readonly keyPrefix: string;
  /** Subchave AES-256 dos tokens (`deriveKey(master, 'session-tokens')`). */
  readonly tokenKey: Buffer;
  readonly now?: () => number;
}

/** Registro serializado: tudo em claro, exceto os tokens. */
type StoredRecord = Omit<SessionRecord, 'tokens'> & { readonly sealedTokens: string };

function isTokens(value: unknown): value is SessionTokens {
  if (typeof value !== 'object' || value === null) return false;
  const tokens = value as Record<string, unknown>;
  return (
    typeof tokens.accessToken === 'string' &&
    typeof tokens.accessTokenExpiresAt === 'number' &&
    (tokens.refreshToken === null || typeof tokens.refreshToken === 'string') &&
    (tokens.idToken === null || typeof tokens.idToken === 'string')
  );
}

export class RedisSessionStore implements SessionStore {
  private readonly now: () => number;

  constructor(
    private readonly redis: SessionRedis,
    private readonly options: RedisSessionStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<SessionRecord | null> {
    const raw = await this.call(() => this.redis.get(this.recordKey(key)));
    if (raw === null) return null;
    return this.decode(key, raw);
  }

  async save(record: SessionRecord): Promise<void> {
    const ttl = this.ttlOf(record);
    if (ttl <= 0) {
      await this.delete(record.key);
      return;
    }
    await this.call(() =>
      this.redis.set(this.recordKey(record.key), this.encode(record), 'PX', ttl),
    );
  }

  async create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]> {
    await this.save(record);
    const index = this.userKey(record.userId);
    await this.call(() => this.redis.zadd(index, record.createdAt, record.key));
    await this.call(() => this.redis.pexpire(index, this.ttlOf(record)));
    const total = await this.call(() => this.redis.zcard(index));
    if (total <= maxPerUser) return [];
    // Sessões mais antigas além do limite (RN-IAM-10): encerradas.
    const evicted = await this.call(() => this.redis.zrange(index, 0, total - maxPerUser - 1));
    if (evicted.length > 0) {
      await this.call(() => this.redis.del(...evicted.map((key) => this.recordKey(key))));
      await this.call(() => this.redis.zrem(index, ...evicted));
    }
    return evicted;
  }

  async delete(key: string): Promise<void> {
    const raw = await this.call(() => this.redis.get(this.recordKey(key)));
    await this.call(() => this.redis.del(this.recordKey(key)));
    const record = raw === null ? null : this.decode(key, raw);
    if (record) await this.call(() => this.redis.zrem(this.userKey(record.userId), key));
  }

  private recordKey(key: string): string {
    return `${this.options.keyPrefix}${key}`;
  }

  private userKey(userId: string): string {
    return `${this.options.keyPrefix}user:${userId}`;
  }

  /** Até o fim absoluto da sessão: depois disso, nem o registro sobra. */
  private ttlOf(record: SessionRecord): number {
    return Math.max(0, record.absoluteExpiresAt - this.now());
  }

  private encode(record: SessionRecord): string {
    const { tokens, ...rest } = record;
    const stored: StoredRecord = {
      ...rest,
      sealedTokens: seal(this.options.tokenKey, JSON.stringify(tokens), record.key),
    };
    return JSON.stringify(stored);
  }

  /** Registro ilegível (outra chave, adulterado): tratado como inexistente. */
  private decode(key: string, raw: string): SessionRecord | null {
    try {
      const { sealedTokens, ...rest } = JSON.parse(raw) as StoredRecord;
      if (rest.key !== key || typeof sealedTokens !== 'string') return null;
      const plain = unseal(this.options.tokenKey, sealedTokens, key);
      if (plain === null) return null;
      const tokens: unknown = JSON.parse(plain);
      return isTokens(tokens) ? { ...rest, tokens } : null;
    } catch {
      return null;
    }
  }

  private async call<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error) {
      throw new SessionStoreUnavailableError({ cause: error });
    }
  }
}
