import { sessionKeyspace } from '@contrataflow/types';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionRedis } from './session-redis.js';
import { MemorySessionRedis } from './session-redis.testing.js';

const MEMBERSHIP = '0192f000-0000-7000-8000-0000000000c1';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const KEY = 'ab'.repeat(32);
const keys = sessionKeyspace('test');

const header = {
  key: KEY,
  userId: USER,
  displayName: 'Bruno',
  activeTenantId: '0192f000-0000-7000-8000-00000000000b',
  membershipId: MEMBERSHIP,
  createdAt: 1_000,
  lastSeenAt: 2_000,
  idleExpiresAt: 3_000,
  absoluteExpiresAt: 4_000,
};

describe('SessionRedis — Redis de sessões (RN-IAM-27)', () => {
  it('lê o índice do vínculo e o cabeçalho do registro vivo, sem expor os tokens', async () => {
    const memory = new MemorySessionRedis();
    const sessions = new SessionRedis({ redisUrl: '', appEnv: 'test' }, memory);
    memory.strings.set(keys.record(KEY), JSON.stringify({ ...header, sealedTokens: 'cifrado' }));
    await memory.sadd(keys.membership(MEMBERSHIP), KEY);

    expect(await sessions.membersOf(MEMBERSHIP)).toEqual([KEY]);
    expect(await sessions.readHeader(KEY)).toEqual(header);
    expect(await sessions.readHeader('f'.repeat(64))).toBeNull();
  });

  it('registro vivo ilegível não é sessão (cabeçalho nulo)', async () => {
    const memory = new MemorySessionRedis();
    const sessions = new SessionRedis({ redisUrl: '', appEnv: 'test' }, memory);
    memory.strings.set(keys.record(KEY), '{não é json');
    expect(await sessions.readHeader(KEY)).toBeNull();
    memory.strings.set(keys.record(KEY), JSON.stringify({ key: KEY }));
    expect(await sessions.readHeader(KEY)).toBeNull();
  });

  it('forget tira só a entrada do índice; end delega ao protocolo compartilhado', async () => {
    const memory = new MemorySessionRedis();
    const sessions = new SessionRedis({ redisUrl: '', appEnv: 'test' }, memory);
    memory.strings.set(keys.record(KEY), JSON.stringify({ ...header, sealedTokens: 'cifrado' }));
    await memory.sadd(keys.membership(MEMBERSHIP), KEY);

    await sessions.forget(MEMBERSHIP, KEY);
    expect(await sessions.membersOf(MEMBERSHIP)).toEqual([]);
    expect(memory.strings.has(keys.record(KEY))).toBe(true);

    expect(await sessions.end({ header, reason: 'MEMBERSHIP_EXPIRED', occurredAt: 5_000 })).toBe(
      true,
    );
    expect(memory.strings.has(keys.record(KEY))).toBe(false);
    expect(memory.strings.has(keys.ended(KEY))).toBe(true);
    expect(await sessions.end({ header, reason: 'MEMBERSHIP_EXPIRED', occurredAt: 6_000 })).toBe(
      false,
    );
  });

  describe('conexão real com o Redis fora', () => {
    const sessions = new SessionRedis({ redisUrl: 'redis://127.0.0.1:1', appEnv: 'test' });

    afterEach(() => {
      sessions.close();
    });

    it('os comandos falham em vez de enfileirar (o job é repetido pela fila)', async () => {
      await expect(sessions.membersOf(MEMBERSHIP)).rejects.toThrow();
    });
  });
});
