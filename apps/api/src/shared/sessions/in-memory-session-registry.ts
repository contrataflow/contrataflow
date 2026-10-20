import { sessionKeyspace } from '@contrataflow/types';
import type { SessionKeyspace } from '@contrataflow/types';
import {
  endSession,
  parseSessionHeader,
  parseSessionTombstone,
  sessionDeadline,
} from '@contrataflow/validation';
import type {
  EndSessionInput,
  SessionEndRedis,
  SessionHeader,
  SessionTombstone,
} from '@contrataflow/validation';

import type { SessionRegistryPort } from './session-registry.js';

/** O mínimo de um Redis que `endSession` e a varredura usam, com TTL pelo relógio injetado. */
class MemoryRedis implements SessionEndRedis {
  readonly strings = new Map<string, { value: string; expiresAt: number }>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();

  constructor(private readonly now: () => number) {}

  get(key: string): string | null {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    if (this.get(key) !== null) return Promise.resolve(null);
    this.strings.set(key, { value, expiresAt: this.now() + ttlMs });
    return Promise.resolve('OK');
  }

  del(...keys: string[]): Promise<number> {
    return Promise.resolve(keys.filter((key) => this.strings.delete(key)).length);
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.sortedSets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member) === true).length);
  }

  srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member) === true).length);
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    const added = set.has(member) ? 0 : 1;
    set.set(member, score);
    this.sortedSets.set(key, set);
    return Promise.resolve(added);
  }
}

/** Retenção do registro vivo depois do fim absoluto (24 h — mesma do registro de encerramento). */
const LIVE_RETENTION_MS = 24 * 3_600_000;

/**
 * Redis de sessões em memória (testes): mesma semântica do adaptador Redis — o encerramento é o
 * `endSession` do protocolo compartilhado, a trava de varredura expira pelo relógio e os registros
 * têm TTL. Os métodos `seed*`/`has*`/`deadlineOf` montam e inspecionam o estado nos testes.
 */
export class InMemorySessionRegistry implements SessionRegistryPort {
  readonly enabled = true;
  readonly keys: SessionKeyspace;
  private readonly redis: MemoryRedis;
  private lockExpiresAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = () => Date.now(),
    appEnv = 'test',
  ) {
    this.keys = sessionKeyspace(appEnv);
    this.redis = new MemoryRedis(now);
  }

  acquireSweepLock(ttlMs: number): Promise<boolean> {
    if (this.now() < this.lockExpiresAt) return Promise.resolve(false);
    this.lockExpiresAt = this.now() + ttlMs;
    return Promise.resolve(true);
  }

  due(now: number, limit: number): Promise<string[]> {
    const scheduled = this.redis.sortedSets.get(this.keys.expiry) ?? new Map<string, number>();
    return Promise.resolve(
      [...scheduled]
        .filter(([, score]) => score <= now)
        .sort(([, left], [, right]) => left - right)
        .slice(0, limit)
        .map(([key]) => key),
    );
  }

  readTombstone(key: string): Promise<SessionTombstone | null> {
    return Promise.resolve(parseSessionTombstone(this.redis.get(this.keys.ended(key))));
  }

  readLive(key: string): Promise<SessionHeader | null> {
    return Promise.resolve(parseSessionHeader(this.redis.get(this.keys.record(key))));
  }

  end(input: EndSessionInput): Promise<boolean> {
    return endSession(this.redis, this.keys, input);
  }

  reschedule(key: string, deadline: number): Promise<void> {
    return this.redis.zadd(this.keys.expiry, deadline, key).then(() => undefined);
  }

  async forget(key: string): Promise<void> {
    await this.redis.del(this.keys.ended(key));
    await this.redis.zrem(this.keys.expiry, key);
  }

  /** Cria uma sessão viva como o BFF a grava (cabeçalho + tokens cifrados), com índices e prazo. */
  seedLive(header: SessionHeader): void {
    this.redis.strings.set(this.keys.record(header.key), {
      value: JSON.stringify({ ...header, sealedTokens: 'tokens-cifrados-que-a-api-nunca-le' }),
      expiresAt: header.absoluteExpiresAt + LIVE_RETENTION_MS,
    });
    void this.redis.zadd(this.keys.user(header.userId), header.createdAt, header.key);
    if (header.membershipId) {
      const members = this.redis.sets.get(this.keys.membership(header.membershipId));
      if (members) members.add(header.key);
      else this.redis.sets.set(this.keys.membership(header.membershipId), new Set([header.key]));
    }
    void this.redis.zadd(this.keys.expiry, sessionDeadline(header), header.key);
  }

  hasLive(key: string): boolean {
    return this.redis.get(this.keys.record(key)) !== null;
  }

  hasTombstone(key: string): boolean {
    return this.redis.get(this.keys.ended(key)) !== null;
  }

  /** Prazo agendado no conjunto de varredura; `undefined` se a chave não está agendada. */
  deadlineOf(key: string): number | undefined {
    return this.redis.sortedSets.get(this.keys.expiry)?.get(key);
  }
}
