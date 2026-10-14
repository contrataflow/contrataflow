import { describe, expect, it } from 'vitest';

import { deriveKey } from '@/bff/crypto';
import { RedisSessionStore } from '@/bff/session/redis-store';
import type { SessionRedis } from '@/bff/session/redis-store';
import { hashSessionId } from '@/bff/session/session-service';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { SessionRecord } from '@/bff/session/types';

/* Redis de sessões (DEC-131 · RN-IAM-10 · US-087 Lacuna 3): chaves, TTL, índice e cifra. */

const NOW = Date.parse('2026-10-14T12:00:00Z');
const PREFIX = 'cf:test:sess:';

/** Redis em memória com o subconjunto de comandos do store (TTLs registrados, não aplicados). */
class FakeRedis implements SessionRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Map<string, number>>();
  readonly ttls = new Map<string, number>();
  down = false;

  private guard(): void {
    if (this.down) throw new Error('Connection is closed.');
  }

  get(key: string) {
    this.guard();
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _mode: 'PX', ttlMs: number) {
    this.guard();
    this.strings.set(key, value);
    this.ttls.set(key, ttlMs);
    return Promise.resolve('OK');
  }

  del(...keys: string[]) {
    this.guard();
    let removed = 0;
    for (const key of keys) if (this.strings.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }

  zadd(key: string, score: number, member: string) {
    this.guard();
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sets.set(key, set);
    return Promise.resolve(1);
  }

  zrange(key: string, start: number, stop: number) {
    this.guard();
    const ordered = [...(this.sets.get(key)?.entries() ?? [])]
      .sort((left, right) => left[1] - right[1])
      .map(([member]) => member);
    return Promise.resolve(ordered.slice(start, stop + 1));
  }

  zrem(key: string, ...members: string[]) {
    this.guard();
    const set = this.sets.get(key);
    for (const member of members) set?.delete(member);
    return Promise.resolve(members.length);
  }

  zcard(key: string) {
    this.guard();
    return Promise.resolve(this.sets.get(key)?.size ?? 0);
  }

  pexpire(key: string, ttlMs: number) {
    this.guard();
    this.ttls.set(key, ttlMs);
    return Promise.resolve(1);
  }
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: hashSessionId(id),
    userId: '0192a000-0000-7000-8000-0000000000a1',
    subject: 'sub',
    displayName: 'Cláudia',
    activeTenantId: null,
    membershipId: null,
    memberships: [],
    tokens: {
      accessToken: `access-${id}`,
      accessTokenExpiresAt: NOW + 300_000,
      refreshToken: `refresh-${id}`,
      idToken: `id-${id}`,
    },
    amr: ['pwd'],
    authTime: NOW,
    firstLogin: false,
    ip: null,
    userAgentHash: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: NOW + 30 * 60_000,
    absoluteExpiresAt: NOW + 12 * 3_600_000,
    ...overrides,
  };
}

function store(redis = new FakeRedis(), key = deriveKey(Buffer.alloc(32, 3), 'session-tokens')) {
  return {
    redis,
    subject: new RedisSessionStore(redis, { keyPrefix: PREFIX, tokenKey: key, now: () => NOW }),
  };
}

describe('RedisSessionStore', () => {
  it('chave = prefixo + SHA-256 do sid; TTL até o fim absoluto; tokens cifrados em repouso', async () => {
    const { redis, subject } = store();
    const session = record('sid-1');
    expect(await subject.create(session, 10)).toEqual([]);
    const raw = redis.strings.get(`${PREFIX}${session.key}`) ?? '';
    expect(raw).not.toContain('access-sid-1');
    expect(raw).not.toContain('refresh-sid-1');
    expect(raw).not.toContain('sid-1"');
    expect(redis.ttls.get(`${PREFIX}${session.key}`)).toBe(12 * 3_600_000);
    expect(redis.sets.get(`${PREFIX}user:${session.userId}`)?.has(session.key)).toBe(true);
    expect(await subject.get(session.key)).toEqual(session);
  });

  it('acima do limite por usuário, encerra as sessões mais antigas', async () => {
    const { redis, subject } = store();
    for (let index = 0; index < 3; index += 1) {
      await subject.create(record(`s${index}`, { createdAt: NOW + index }), 3);
    }
    const evicted = await subject.create(record('s3', { createdAt: NOW + 3 }), 3);
    expect(evicted).toEqual([hashSessionId('s0')]);
    expect(await subject.get(hashSessionId('s0'))).toBeNull();
    expect(redis.sets.get(`${PREFIX}user:${record('x').userId}`)?.size).toBe(3);
  });

  it('save atualiza; registro vencido é apagado; delete tira do índice', async () => {
    const { redis, subject } = store();
    const session = record('sid-2');
    await subject.create(session, 10);
    await subject.save({ ...session, activeTenantId: 't' });
    expect((await subject.get(session.key))?.activeTenantId).toBe('t');
    await subject.save({ ...session, absoluteExpiresAt: NOW });
    expect(await subject.get(session.key)).toBeNull();
    await subject.create(session, 10);
    await subject.delete(session.key);
    expect(await subject.get(session.key)).toBeNull();
    expect(redis.sets.get(`${PREFIX}user:${session.userId}`)?.has(session.key)).toBe(false);
    await subject.delete('inexistente');
  });

  it('registro adulterado, movido para outra chave ou de outra chave de cifra → inexistente', async () => {
    const { redis, subject } = store();
    const session = record('sid-3');
    await subject.create(session, 10);
    const raw = redis.strings.get(`${PREFIX}${session.key}`) ?? '';
    redis.strings.set(
      `${PREFIX}${session.key}`,
      raw.replace('Cláudia', 'Mallory').replace(/"sealedTokens":"(.)/, '"sealedTokens":"X'),
    );
    expect(await subject.get(session.key)).toBeNull();
    redis.strings.set(`${PREFIX}outra`, raw);
    expect(await subject.get('outra')).toBeNull();
    redis.strings.set(`${PREFIX}lixo`, 'não-json');
    expect(await subject.get('lixo')).toBeNull();
    const other = store(redis, deriveKey(Buffer.alloc(32, 4), 'session-tokens'));
    await subject.create(session, 10);
    expect(await other.subject.get(session.key)).toBeNull();
  });

  it('[Falha de integração] Redis fora do ar → SessionStoreUnavailableError (503 no BFF)', async () => {
    const { redis, subject } = store();
    redis.down = true;
    await expect(subject.get('x')).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    await expect(subject.create(record('s'), 10)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });
});
