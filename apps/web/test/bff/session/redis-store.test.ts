import { SESSION_ENDED_RETENTION_MS } from '@contrataflow/types';
import { describe, expect, it, vi } from 'vitest';

import { deriveKey } from '@/bff/crypto';
import { RedisSessionStore, SESSION_UPDATE_ATTEMPTS } from '@/bff/session/redis-store';
import type { SessionRedis } from '@/bff/session/redis-store';
import { hashSessionId } from '@/bff/session/session-service';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { SessionRecord } from '@/bff/session/types';

/*
 * Redis de sessões (DEC-131 · RN-IAM-10 · US-087 Lacuna 3 · US-088): chaves, TTL, índices, cifra,
 * encerramento sem ressurreição e trava de renovação.
 */

const NOW = Date.parse('2026-10-14T12:00:00Z');
const PREFIX = 'cf:test:sess:';
const RETENTION = SESSION_ENDED_RETENTION_MS;

/** Redis em memória com o subconjunto de comandos do store (TTLs registrados, não aplicados). */
class FakeRedis implements SessionRedis {
  readonly strings = new Map<string, string>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();
  readonly ttls = new Map<string, number>();
  down = false;

  private guard(): void {
    if (this.down) throw new Error('Connection is closed.');
  }

  get(key: string) {
    this.guard();
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _mode: 'PX', ttlMs: number, condition?: 'NX' | 'XX') {
    this.guard();
    const exists = this.strings.has(key);
    if ((condition === 'NX' && exists) || (condition === 'XX' && !exists)) {
      return Promise.resolve(null);
    }
    this.strings.set(key, value);
    this.ttls.set(key, ttlMs);
    return Promise.resolve('OK' as const);
  }

  del(...keys: string[]) {
    this.guard();
    return Promise.resolve(keys.filter((key) => this.strings.delete(key)).length);
  }

  zadd(key: string, score: number, member: string) {
    this.guard();
    const set = this.zsets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.zsets.set(key, set);
    return Promise.resolve(1);
  }

  zrange(key: string, start: number, stop: number) {
    this.guard();
    const ordered = [...(this.zsets.get(key)?.entries() ?? [])]
      .sort((left, right) => left[1] - right[1])
      .map(([member]) => member);
    return Promise.resolve(ordered.slice(start, stop + 1));
  }

  zrem(key: string, ...members: string[]) {
    this.guard();
    const set = this.zsets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member)).length);
  }

  zcard(key: string) {
    this.guard();
    return Promise.resolve(this.zsets.get(key)?.size ?? 0);
  }

  sadd(key: string, ...members: string[]) {
    this.guard();
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return Promise.resolve(members.length);
  }

  srem(key: string, ...members: string[]) {
    this.guard();
    const set = this.sets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member)).length);
  }

  pexpire(key: string, ttlMs: number) {
    this.guard();
    this.ttls.set(key, ttlMs);
    return Promise.resolve(1);
  }

  /** Só o *compare-and-set* do store (`SESSION_CAS_SCRIPT`). */
  eval(_script: string, _numKeys: number, ...args: (string | number)[]) {
    this.guard();
    const [key, expected, value, ttl] = args.map(String);
    if (key === undefined || this.strings.get(key) !== expected) return Promise.resolve(0);
    this.strings.set(key, value ?? '');
    this.ttls.set(key, Number(ttl));
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
    idleMinutes: 30,
    idleExpiresAt: NOW + 30 * 60_000,
    absoluteExpiresAt: NOW + 12 * 3_600_000,
    ...overrides,
  };
}

function store(redis = new FakeRedis(), key = deriveKey(Buffer.alloc(32, 3), 'session-tokens')) {
  return {
    redis,
    subject: new RedisSessionStore(redis, { appEnv: 'test', tokenKey: key, now: () => NOW }),
  };
}

describe('RedisSessionStore', () => {
  it('chave = prefixo + SHA-256 do sid; TTL até 24 h após o fim absoluto; tokens cifrados', async () => {
    const { redis, subject } = store();
    const session = record('sid-1');
    expect(await subject.create(session, 10)).toEqual([]);
    const raw = redis.strings.get(`${PREFIX}${session.key}`) ?? '';
    expect(raw).not.toContain('access-sid-1');
    expect(raw).not.toContain('refresh-sid-1');
    expect(raw).not.toContain('sid-1"');
    // A varredura da API precisa ler a sessão nunca mais acessada para auditá-la (RN-IAM-28).
    expect(redis.ttls.get(`${PREFIX}${session.key}`)).toBe(12 * 3_600_000 + RETENTION);
    expect(redis.zsets.get(`${PREFIX}user:${session.userId}`)?.has(session.key)).toBe(true);
    expect(redis.zsets.get(`${PREFIX}expiry`)?.get(session.key)).toBe(session.idleExpiresAt);
    expect(await subject.get(session.key)).toEqual(session);
  });

  it('acima do limite por usuário, encerra as mais antigas com SESSION_LIMIT', async () => {
    const { redis, subject } = store();
    for (let index = 0; index < 3; index += 1) {
      await subject.create(record(`s${index}`, { createdAt: NOW + index }), 3);
    }
    const evicted = await subject.create(record('s3', { createdAt: NOW + 3 }), 3);
    expect(evicted).toEqual([hashSessionId('s0')]);
    expect(await subject.get(hashSessionId('s0'))).toBeNull();
    expect((await subject.getEnded(hashSessionId('s0')))?.reason).toBe('SESSION_LIMIT');
    expect(redis.zsets.get(`${PREFIX}user:${record('x').userId}`)?.size).toBe(3);
  });

  it('entrada órfã no índice do usuário sai sem encerramento', async () => {
    const { redis, subject } = store();
    await redis.zadd(`${PREFIX}user:${record('x').userId}`, NOW - 1, 'orfa');
    expect(await subject.create(record('novo'), 1)).toEqual(['orfa']);
    expect(await subject.getEnded('orfa')).toBeNull();
  });

  it('save atualiza só sessão viva: encerrada não é recriada por gravação atrasada', async () => {
    const { subject } = store();
    const session = record('sid-2');
    await subject.create(session, 10);
    await subject.save({ ...session, activeTenantId: 't' });
    expect((await subject.get(session.key))?.activeTenantId).toBe('t');
    expect(
      await subject.end(session, { reason: 'LOGOUT', occurredAt: NOW, ip: null, userAgent: null }),
    ).toBe(true);
    await subject.save({ ...session, lastSeenAt: NOW + 1 });
    expect(await subject.get(session.key)).toBeNull();
    expect(
      await subject.end(session, { reason: 'LOGOUT', occurredAt: NOW, ip: null, userAgent: null }),
    ).toBe(false);
  });

  it('update (US-093): compare-and-set sobre o registro mais recente, refeito se outro gravou no meio', async () => {
    const { redis, subject } = store();
    const session = record('sid-cas');
    await subject.create(session, 10);
    const rotated = { ...session.tokens, accessToken: 'access-rotacionado' };
    let interfered = false;
    const updated = await subject.update(session.key, (current) => {
      if (!interfered) {
        interfered = true;
        // Outra réplica renova os tokens entre a leitura e a gravação desta.
        redis.strings.set(
          `${PREFIX}${session.key}`,
          JSON.stringify({
            ...JSON.parse(redis.strings.get(`${PREFIX}${session.key}`) ?? '{}'),
            x: 1,
          }),
        );
      }
      return { ...current, activeTenantId: 'tenant-b', membershipId: 'm-b' };
    });
    expect(interfered).toBe(true);
    expect(updated).toMatchObject({ activeTenantId: 'tenant-b', membershipId: 'm-b' });
    expect(await subject.get(session.key)).toMatchObject({
      activeTenantId: 'tenant-b',
      membershipId: 'm-b',
      tokens: session.tokens,
    });
    // Campos que a gravação não mexe ficam como estavam no registro mais recente.
    await subject.update(session.key, (current) => ({ ...current, tokens: rotated }));
    expect(await subject.get(session.key)).toMatchObject({
      activeTenantId: 'tenant-b',
      tokens: rotated,
    });
    expect(redis.ttls.get(`${PREFIX}${session.key}`)).toBe(12 * 3_600_000 + RETENTION);
  });

  it('update: sessão encerrada ou ilegível → null; disputa contínua → indisponível (503)', async () => {
    const { redis, subject } = store();
    expect(await subject.update('inexistente', (current) => current)).toBeNull();
    redis.strings.set(`${PREFIX}adulterada`, '{"key":"adulterada"}');
    expect(await subject.update('adulterada', (current) => current)).toBeNull();
    const session = record('sid-disputa');
    await subject.create(session, 10);
    const compareAndSet = vi.spyOn(redis, 'eval').mockResolvedValue(0);
    await expect(subject.update(session.key, (current) => current)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
    expect(compareAndSet).toHaveBeenCalledTimes(SESSION_UPDATE_ATTEMPTS);
  });

  it('encerramento: registro sem tokens com motivo e cliente, fora dos índices e agendado', async () => {
    const { redis, subject } = store();
    const session = record('sid-4', { activeTenantId: 'tenant-a', membershipId: 'm-a' });
    await subject.create(session, 10);
    await subject.reindex(session, null);
    expect(redis.sets.get(`${PREFIX}membership:m-a`)?.has(session.key)).toBe(true);
    await subject.end(session, {
      reason: 'IDLE',
      occurredAt: session.idleExpiresAt,
      ip: '10.0.0.7',
      userAgent: 'Firefox',
    });
    const ended = await subject.getEnded(session.key);
    expect(ended).toMatchObject({
      reason: 'IDLE',
      occurredAt: session.idleExpiresAt,
      activeTenantId: 'tenant-a',
      ip: '10.0.0.7',
    });
    expect(JSON.stringify(ended)).not.toContain('access-sid-4');
    expect(redis.ttls.get(`${PREFIX}end:${session.key}`)).toBe(RETENTION);
    expect(redis.sets.get(`${PREFIX}membership:m-a`)?.size).toBe(0);
    expect(redis.zsets.get(`${PREFIX}user:${session.userId}`)?.size).toBe(0);
    expect(redis.zsets.get(`${PREFIX}expiry`)?.get(session.key)).toBe(session.idleExpiresAt);
    redis.strings.set(`${PREFIX}end:lixo`, '{');
    expect(await subject.getEnded('lixo')).toBeNull();
  });

  it('troca de vínculo move a sessão de índice e reagenda o prazo', async () => {
    const { redis, subject } = store();
    const session = record('sid-5', { activeTenantId: 'tenant-a', membershipId: 'm-a' });
    await subject.create(session, 10);
    await subject.reindex(session, null);
    const moved = { ...session, membershipId: 'm-b', idleExpiresAt: NOW + 5 * 60_000 };
    await subject.reindex(moved, 'm-a');
    expect(redis.sets.get(`${PREFIX}membership:m-a`)?.has(session.key)).toBe(false);
    expect(redis.sets.get(`${PREFIX}membership:m-b`)?.has(session.key)).toBe(true);
    expect(redis.zsets.get(`${PREFIX}expiry`)?.get(session.key)).toBe(NOW + 5 * 60_000);
    await subject.reindex({ ...moved, membershipId: null }, null);
  });

  it('trava de renovação: um dono por vez; só o dono libera', async () => {
    const { redis, subject } = store();
    const owner = await subject.acquireRefreshLock('k', 10_000);
    expect(owner).not.toBeNull();
    expect(redis.ttls.get(`${PREFIX}lock:k`)).toBe(10_000);
    expect(await subject.acquireRefreshLock('k', 10_000)).toBeNull();
    await subject.releaseRefreshLock('k', 'outro-dono');
    expect(await subject.acquireRefreshLock('k', 10_000)).toBeNull();
    await subject.releaseRefreshLock('k', owner ?? '');
    expect(await subject.acquireRefreshLock('k', 10_000)).not.toBeNull();
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

  it('sessão gravada antes da US-088 (sem idleMinutes) usa a ociosidade padrão', async () => {
    const { redis, subject } = store();
    const session = record('antiga');
    await subject.create(session, 10);
    const raw = JSON.parse(redis.strings.get(`${PREFIX}${session.key}`) ?? '{}') as Record<
      string,
      unknown
    >;
    delete raw.idleMinutes;
    redis.strings.set(`${PREFIX}${session.key}`, JSON.stringify(raw));
    expect((await subject.get(session.key))?.idleMinutes).toBe(30);
  });

  it('[Falha de integração] Redis fora do ar → SessionStoreUnavailableError (503 no BFF)', async () => {
    const { redis, subject } = store();
    redis.down = true;
    await expect(subject.get('x')).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    await expect(subject.create(record('s'), 10)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
    await expect(
      subject.end(record('s'), { reason: 'LOGOUT', occurredAt: NOW, ip: null, userAgent: null }),
    ).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    await expect(subject.acquireRefreshLock('k', 1)).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });
});
