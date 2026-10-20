import 'server-only';

import { randomInt, randomUUID } from 'node:crypto';

import {
  DEFAULT_SESSION_POLICY,
  SESSION_ENDED_RETENTION_MS,
  sessionKeyspace,
} from '@contrataflow/types';
import type { SessionKeyspace } from '@contrataflow/types';
import {
  endSession,
  parseSessionHeader,
  parseSessionTombstone,
  sessionDeadline,
} from '@contrataflow/validation';
import type { SessionEndRedis, SessionTombstone } from '@contrataflow/validation';

import { seal, unseal } from '../crypto';
import { SessionStoreUnavailableError } from './types';
import type { SessionEnding, SessionRecord, SessionStore, SessionTokens } from './types';

/*
 * Redis de sessões (DEC-131 · RN-IAM-10 · US-087 Lacuna 3 · US-088), layout em
 * `@contrataflow/types` (`sessionKeyspace`): `cf:{env}:sess:{sha256(sid)}` guarda o registro
 * (tokens cifrados com AES-256-GCM, amarrados à chave da sessão), com TTL até 24 h depois do fim
 * absoluto — a varredura da API precisa ler as sessões nunca mais acessadas para auditá-las;
 * `…:user:{userId}` (sorted set por criação) limita as sessões simultâneas; `…:membership:{id}`
 * (conjunto) serve ao encerramento pelos eventos de vínculo (worker); `…:expiry` (sorted set por
 * prazo) é a fila da varredura. O encerramento segue o protocolo de `@contrataflow/validation`
 * (`endSession`), o mesmo da API e do worker. Chaves de plataforma: nunca passam pelo `TenantCache`.
 */

/** Subconjunto do ioredis usado aqui (facilita o teste com um Redis em memória). */
export interface SessionRedis extends SessionEndRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'XX'): Promise<'OK' | null>;
  // O ioredis declara `NX` e `XX` em sobrecargas separadas: a união não seria atribuível.
  // eslint-disable-next-line @typescript-eslint/unified-signatures -- ver comentário acima
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zcard(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * *Compare-and-set* do registro: grava só se o valor ainda é o lido (nenhuma outra gravação no
 * meio). O registro é JSON com os tokens cifrados — o script não interpreta o conteúdo.
 */
export const SESSION_CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

/**
 * Tentativas do *compare-and-set* sob disputa antes de responder indisponível (503). Cada rodada
 * tem um vencedor; com espera aleatória curta entre as tentativas, dezenas de requisições
 * paralelas da mesma sessão se resolvem bem antes do limite.
 */
export const SESSION_UPDATE_ATTEMPTS = 64;
/** Teto da espera aleatória entre tentativas do *compare-and-set*. */
const SESSION_UPDATE_MAX_BACKOFF_MS = 10;

function backoff(attempt: number): Promise<void> {
  const maxMs = Math.min(SESSION_UPDATE_MAX_BACKOFF_MS, 1 + attempt * 2);
  const ms = randomInt(maxMs * 1000) / 1000;
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RedisSessionStoreOptions {
  /** `APP_ENV` — compõe o prefixo `cf:{env}:sess:`. */
  readonly appEnv: string;
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
  private readonly keys: SessionKeyspace;

  constructor(
    private readonly redis: SessionRedis,
    private readonly options: RedisSessionStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.keys = sessionKeyspace(options.appEnv);
  }

  async get(key: string): Promise<SessionRecord | null> {
    const raw = await this.call(() => this.redis.get(this.keys.record(key)));
    if (raw === null) return null;
    return this.decode(key, raw);
  }

  async save(record: SessionRecord): Promise<void> {
    // `XX`: sessão encerrada (logout, vínculo, expiração) não volta por uma gravação atrasada.
    await this.call(() =>
      this.redis.set(
        this.keys.record(record.key),
        this.encode(record),
        'PX',
        this.ttlOf(record),
        'XX',
      ),
    );
  }

  async update(
    key: string,
    mutate: (current: SessionRecord) => SessionRecord,
  ): Promise<SessionRecord | null> {
    const recordKey = this.keys.record(key);
    for (let attempt = 0; attempt < SESSION_UPDATE_ATTEMPTS; attempt += 1) {
      const raw = await this.call(() => this.redis.get(recordKey));
      if (raw === null) return null;
      const current = this.decode(key, raw);
      if (!current) return null;
      const next = mutate(current);
      const swapped = await this.call(() =>
        this.redis.eval(
          SESSION_CAS_SCRIPT,
          1,
          recordKey,
          raw,
          this.encode(next),
          String(this.ttlOf(next)),
        ),
      );
      if (swapped === 1) return next;
      await backoff(attempt);
    }
    throw new SessionStoreUnavailableError({
      cause: new Error('Disputa contínua na gravação da sessão.'),
    });
  }

  async create(record: SessionRecord, maxPerUser: number): Promise<readonly string[]> {
    const ttl = this.ttlOf(record);
    await this.call(() =>
      this.redis.set(this.keys.record(record.key), this.encode(record), 'PX', ttl),
    );
    const index = this.keys.user(record.userId);
    await this.call(() => this.redis.zadd(index, record.createdAt, record.key));
    await this.call(() => this.redis.pexpire(index, ttl));
    await this.call(() => this.redis.zadd(this.keys.expiry, sessionDeadline(record), record.key));
    const total = await this.call(() => this.redis.zcard(index));
    if (total <= maxPerUser) return [];
    // Sessões mais antigas além do limite (RN-IAM-10): encerradas com `SESSION_LIMIT`.
    const evicted = await this.call(() => this.redis.zrange(index, 0, total - maxPerUser - 1));
    for (const key of evicted) {
      const header = parseSessionHeader(
        await this.call(() => this.redis.get(this.keys.record(key))),
      );
      if (header) {
        await this.call(() =>
          endSession(this.redis, this.keys, {
            header,
            reason: 'SESSION_LIMIT',
            occurredAt: this.now(),
          }),
        );
      } else {
        await this.call(() => this.redis.zrem(index, key));
      }
    }
    return evicted;
  }

  async reindex(record: SessionRecord, previousMembershipId: string | null): Promise<void> {
    if (previousMembershipId && previousMembershipId !== record.membershipId) {
      await this.call(() =>
        this.redis.srem(this.keys.membership(previousMembershipId), record.key),
      );
    }
    if (record.membershipId) {
      const index = this.keys.membership(record.membershipId);
      await this.call(() => this.redis.sadd(index, record.key));
      await this.call(() => this.redis.pexpire(index, this.ttlOf(record)));
    }
    // Limites da nova instituição: a varredura passa a olhar o novo prazo.
    await this.call(() => this.redis.zadd(this.keys.expiry, sessionDeadline(record), record.key));
  }

  end(record: SessionRecord, ending: SessionEnding): Promise<boolean> {
    return this.call(() =>
      endSession(this.redis, this.keys, {
        header: record,
        reason: ending.reason,
        occurredAt: ending.occurredAt,
        ip: ending.ip,
        userAgent: ending.userAgent,
      }),
    );
  }

  async getEnded(key: string): Promise<SessionTombstone | null> {
    return parseSessionTombstone(await this.call(() => this.redis.get(this.keys.ended(key))));
  }

  async acquireRefreshLock(key: string, ttlMs: number): Promise<string | null> {
    const owner = randomUUID();
    const acquired = await this.call(() =>
      this.redis.set(this.keys.refreshLock(key), owner, 'PX', ttlMs, 'NX'),
    );
    return acquired === null ? null : owner;
  }

  async releaseRefreshLock(key: string, owner: string): Promise<void> {
    // Só o dono libera; uma trava vencida e retomada por outra réplica não é apagada daqui.
    const lock = this.keys.refreshLock(key);
    if ((await this.call(() => this.redis.get(lock))) === owner) {
      await this.call(() => this.redis.del(lock));
    }
  }

  /** Até 24 h depois do fim absoluto: a varredura audita as sessões nunca mais acessadas. */
  private ttlOf(record: SessionRecord): number {
    return Math.max(1, record.absoluteExpiresAt + SESSION_ENDED_RETENTION_MS - this.now());
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
      if (!isTokens(tokens)) return null;
      // Sessões gravadas antes da US-088 não têm `idleMinutes`: padrão da plataforma.
      const idleMinutes =
        typeof rest.idleMinutes === 'number'
          ? rest.idleMinutes
          : DEFAULT_SESSION_POLICY.idleMinutes;
      return { ...rest, idleMinutes, tokens };
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
