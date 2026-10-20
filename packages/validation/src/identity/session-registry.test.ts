import { SESSION_ENDED_RETENTION_MS, sessionKeyspace } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  endSession,
  parseSessionHeader,
  parseSessionTombstone,
  sessionDeadline,
  sessionExpiry,
} from './session-registry.js';
import type { SessionEndRedis, SessionHeader } from './session-registry.js';

/* Protocolo do Redis de sessões (US-088 · RN-IAM-24/27/28). */

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T08:00:00Z');
const keys = sessionKeyspace('test');

function header(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    key: 'k'.repeat(64),
    userId: 'user-1',
    displayName: 'Cláudia',
    activeTenantId: 'tenant-a',
    membershipId: 'membership-a',
    createdAt: T0,
    lastSeenAt: T0,
    idleExpiresAt: T0 + 30 * MIN,
    absoluteExpiresAt: T0 + 12 * 60 * MIN,
    idleMinutes: 30,
    ...overrides,
  };
}

class FakeRedis implements SessionEndRedis {
  readonly strings = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();

  set(key: string, value: string, _mode: 'PX', ttlMs: number, _condition: 'NX') {
    if (this.strings.has(key)) return Promise.resolve(null);
    this.strings.set(key, value);
    this.ttls.set(key, ttlMs);
    return Promise.resolve('OK' as const);
  }

  del(...list: string[]) {
    return Promise.resolve(list.filter((key) => this.strings.delete(key)).length);
  }

  zrem(key: string, ...members: string[]) {
    const set = this.zsets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member)).length);
  }

  srem(key: string, ...members: string[]) {
    const set = this.sets.get(key);
    return Promise.resolve(members.filter((member) => set?.delete(member)).length);
  }

  zadd(key: string, score: number, member: string) {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.zsets.set(key, set);
    return Promise.resolve(1);
  }
}

describe('prazos da sessão', () => {
  it('ociosidade vence primeiro → IDLE no horário do limite, não no da detecção', () => {
    const live = header();
    expect(sessionDeadline(live)).toBe(T0 + 30 * MIN);
    expect(sessionExpiry(live, T0 + 29 * MIN)).toBeNull();
    expect(sessionExpiry(live, T0 + 31 * MIN)).toEqual({
      reason: 'IDLE',
      occurredAt: T0 + 30 * MIN,
    });
  });

  it('ociosidade colada no fim absoluto conta como ABSOLUTE (nunca prorrogado)', () => {
    const live = header({ idleExpiresAt: T0 + 12 * 60 * MIN, lastSeenAt: T0 + 719 * MIN });
    expect(sessionDeadline(live)).toBe(T0 + 12 * 60 * MIN);
    expect(sessionExpiry(live, T0 + 12 * 60 * MIN)).toEqual({
      reason: 'ABSOLUTE',
      occurredAt: T0 + 12 * 60 * MIN,
    });
  });
});

describe('leitura dos registros', () => {
  it('cabeçalho ignora os tokens cifrados; JSON inválido ou incompleto → null', () => {
    const raw = JSON.stringify({ ...header(), sealedTokens: 'cifrado', memberships: [] });
    expect(parseSessionHeader(raw)).toEqual(header());
    expect(parseSessionHeader(null)).toBeNull();
    expect(parseSessionHeader('{')).toBeNull();
    expect(parseSessionHeader(JSON.stringify({ key: 'x' }))).toBeNull();
    expect(parseSessionTombstone(JSON.stringify({ ...header(), reason: 'OUTRO' }))).toBeNull();
  });
});

describe('endSession', () => {
  it('troca o registro vivo pelo de encerramento (sem tokens) e o agenda para a varredura', async () => {
    const redis = new FakeRedis();
    const live = header();
    redis.strings.set(keys.record(live.key), JSON.stringify({ ...live, sealedTokens: 'x' }));
    redis.zsets.set(keys.user(live.userId), new Map([[live.key, T0]]));
    redis.sets.set(keys.membership('membership-a'), new Set([live.key]));

    const ended = await endSession(redis, keys, {
      header: live,
      reason: 'LOGOUT',
      occurredAt: T0 + 5 * MIN,
      ip: '10.0.0.1',
      userAgent: 'Firefox',
    });

    expect(ended).toBe(true);
    expect(redis.strings.has(keys.record(live.key))).toBe(false);
    const tombstone = parseSessionTombstone(redis.strings.get(keys.ended(live.key)) ?? null);
    expect(tombstone).toMatchObject({
      reason: 'LOGOUT',
      occurredAt: T0 + 5 * MIN,
      activeTenantId: 'tenant-a',
      ip: '10.0.0.1',
      userAgent: 'Firefox',
    });
    expect(JSON.stringify(tombstone)).not.toContain('sealedTokens');
    expect(redis.ttls.get(keys.ended(live.key))).toBe(SESSION_ENDED_RETENTION_MS);
    expect(redis.zsets.get(keys.user(live.userId))?.size).toBe(0);
    expect(redis.sets.get(keys.membership('membership-a'))?.size).toBe(0);
    expect(redis.zsets.get(keys.expiry)?.get(live.key)).toBe(T0 + 5 * MIN);
  });

  it('[Duplicidade] segundo encerramento não vence nem reagenda (auditoria única)', async () => {
    const redis = new FakeRedis();
    const live = header({ membershipId: null, activeTenantId: null, idleMinutes: undefined });
    expect(await endSession(redis, keys, { header: live, reason: 'IDLE', occurredAt: T0 })).toBe(
      true,
    );
    redis.zsets.get(keys.expiry)?.delete(live.key);
    expect(
      await endSession(redis, keys, { header: live, reason: 'LOGOUT', occurredAt: T0 + MIN }),
    ).toBe(false);
    const tombstone = parseSessionTombstone(redis.strings.get(keys.ended(live.key)) ?? null);
    expect(tombstone?.reason).toBe('IDLE');
    expect(tombstone?.idleMinutes).toBe(30);
    expect(tombstone?.ip).toBeNull();
    expect(redis.zsets.get(keys.expiry)?.size).toBe(0);
  });
});
