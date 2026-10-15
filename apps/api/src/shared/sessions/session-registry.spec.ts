import { SESSION_ENDED_RETENTION_MS, sessionKeyspace } from '@contrataflow/types';
import type { SessionHeader } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { InMemorySessionRegistry } from './in-memory-session-registry.js';
import { DisabledSessionRegistry } from './session-registry.js';

/* US-088 — o registro de sessões em memória deve se comportar como o Redis do BFF. */

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-14T12:00:00.000Z');

function header(key: string, overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    key,
    userId: 'user-1',
    displayName: 'Cláudia Ramos',
    activeTenantId: 'tenant-a',
    membershipId: 'membership-1',
    createdAt: T0,
    lastSeenAt: T0,
    idleExpiresAt: T0 + 30 * MINUTE,
    absoluteExpiresAt: T0 + 12 * 60 * MINUTE,
    idleMinutes: 30,
    ...overrides,
  };
}

describe('DisabledSessionRegistry', () => {
  it('fica desligado e nunca devolve nada', async () => {
    const registry = new DisabledSessionRegistry();
    expect(registry.enabled).toBe(false);
    await expect(registry.acquireSweepLock()).resolves.toBe(false);
    await expect(registry.due()).resolves.toEqual([]);
    await expect(registry.readTombstone()).resolves.toBeNull();
    await expect(registry.readLive()).resolves.toBeNull();
    await expect(registry.end()).resolves.toBe(false);
    await expect(registry.reschedule()).resolves.toBeUndefined();
    await expect(registry.forget()).resolves.toBeUndefined();
  });
});

describe('InMemorySessionRegistry', () => {
  it('a trava da varredura é de uma réplica por vez e expira pelo relógio', async () => {
    let now = T0;
    const registry = new InMemorySessionRegistry(() => now);
    await expect(registry.acquireSweepLock(50_000)).resolves.toBe(true);
    await expect(registry.acquireSweepLock(50_000)).resolves.toBe(false);
    now += 49_999;
    await expect(registry.acquireSweepLock(50_000)).resolves.toBe(false);
    now += 1;
    await expect(registry.acquireSweepLock(50_000)).resolves.toBe(true);
  });

  it('due devolve só os prazos vencidos, do mais antigo ao mais novo, até o limite', async () => {
    const registry = new InMemorySessionRegistry(() => T0);
    await registry.reschedule('c', T0 - MINUTE);
    await registry.reschedule('a', T0 - 3 * MINUTE);
    await registry.reschedule('b', T0 - 2 * MINUTE);
    await registry.reschedule('futura', T0 + MINUTE);
    await expect(registry.due(T0, 500)).resolves.toEqual(['a', 'b', 'c']);
    await expect(registry.due(T0, 2)).resolves.toEqual(['a', 'b']);
    await expect(registry.due(T0 - 2 * MINUTE, 500)).resolves.toEqual(['a', 'b']);
  });

  it('semeia a sessão viva como o BFF: lê só o cabeçalho (sem tokens) e agenda o menor limite', async () => {
    const registry = new InMemorySessionRegistry(() => T0);
    registry.seedLive(header('s1'));
    const live = await registry.readLive('s1');
    expect(live).toEqual(header('s1'));
    expect(JSON.stringify(live)).not.toContain('tokens');
    expect(registry.deadlineOf('s1')).toBe(T0 + 30 * MINUTE);
    expect(registry.hasLive('s1')).toBe(true);
    await expect(registry.readLive('inexistente')).resolves.toBeNull();
  });

  it('semeia sem vínculo e acumula as sessões do mesmo vínculo no índice', () => {
    const registry = new InMemorySessionRegistry(() => T0);
    registry.seedLive(header('s1'));
    registry.seedLive(header('s2'));
    registry.seedLive(header('s3', { membershipId: null, activeTenantId: null }));
    expect([registry.hasLive('s1'), registry.hasLive('s2'), registry.hasLive('s3')]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('end troca o registro vivo pelo de encerramento sem tokens e só o primeiro encerramento vence', async () => {
    const registry = new InMemorySessionRegistry(() => T0 + 40 * MINUTE);
    registry.seedLive(header('s1'));

    const first = await registry.end({
      header: header('s1'),
      reason: 'IDLE',
      occurredAt: T0 + 30 * MINUTE,
    });
    const second = await registry.end({
      header: header('s1'),
      reason: 'LOGOUT',
      occurredAt: T0 + 35 * MINUTE,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(registry.hasLive('s1')).toBe(false);
    const tombstone = await registry.readTombstone('s1');
    expect(tombstone).toMatchObject({
      key: 's1',
      reason: 'IDLE',
      occurredAt: T0 + 30 * MINUTE,
      activeTenantId: 'tenant-a',
    });
    expect(JSON.stringify(tombstone)).not.toContain('tokens');
    expect(registry.deadlineOf('s1')).toBe(T0 + 30 * MINUTE);
  });

  it('o registro de encerramento expira em 24 h; forget apaga o registro e o prazo', async () => {
    let now = T0;
    const registry = new InMemorySessionRegistry(() => now);
    registry.seedLive(header('s1'));
    await registry.end({ header: header('s1'), reason: 'LOGOUT', occurredAt: T0 + MINUTE });
    expect(registry.hasTombstone('s1')).toBe(true);

    await registry.forget('s1');
    expect(registry.hasTombstone('s1')).toBe(false);
    expect(registry.deadlineOf('s1')).toBeUndefined();

    await registry.end({ header: header('s2'), reason: 'LOGOUT', occurredAt: T0 });
    now += SESSION_ENDED_RETENTION_MS;
    await expect(registry.readTombstone('s2')).resolves.toBeNull();
  });

  it('usa o prefixo do ambiente e não confunde registro vivo com o de encerramento', async () => {
    const registry = new InMemorySessionRegistry(() => T0, 'staging');
    expect(registry.keys.prefix).toBe(sessionKeyspace('staging').prefix);
    registry.seedLive(header('s1'));
    expect(registry.keys.record('s1')).toBe('cf:staging:sess:s1');
    expect(registry.keys.ended('s1')).toBe('cf:staging:sess:end:s1');
    await expect(registry.readTombstone('s1')).resolves.toBeNull();
  });
});
