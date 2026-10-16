import { sessionKeyspace } from '@contrataflow/types';
import type { DomainEventEnvelope, SessionEndReason } from '@contrataflow/types';
import { parseSessionTombstone } from '@contrataflow/validation';
import type { SessionHeader } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { SessionRedis } from '#shared/cache/session-redis.js';
import { MemorySessionRedis } from '#shared/cache/session-redis.testing.js';
import type { TenantRedisCache } from '#shared/cache/tenant-redis.js';

import { DomainEventsProcessor } from './domain-events.processor.js';
import type { FanOutJob, FanOutQueues } from './domain-events.processor.js';
import { PermissionCacheInvalidator } from './inline-handlers.js';
import { DOMAIN_EVENT_ROUTES, resolveRoutes } from './routes.js';
import {
  SessionTerminationDisabled,
  SessionTerminationHandler,
} from './session-termination.handler.js';
import type { SessionTerminationLogger } from './session-termination.handler.js';

const APP_ENV = 'test';
const keys = sessionKeyspace(APP_ENV);

// Bruno tem vínculo na Prefeitura de São José (A) e na de Santa Luzia (B).
const SAO_JOSE = '0192f000-0000-7000-8000-00000000000a';
const SANTA_LUZIA = '0192f000-0000-7000-8000-00000000000b';
const BRUNO = '0192f000-0000-7000-8000-0000000000a1';
const BRUNO_SAO_JOSE = '0192f000-0000-7000-8000-0000000000c1';
const BRUNO_SANTA_LUZIA = '0192f000-0000-7000-8000-0000000000c2';
const EVENT = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';
const NOW = new Date('2026-10-15T12:00:00.000Z');

// Chaves de sessão reais são sha256(sid) em hexadecimal.
const KEY_SAO_JOSE = 'a1'.repeat(32);
const KEY_SANTA_LUZIA = 'b2'.repeat(32);
const KEY_OTHER = 'c3'.repeat(32);

function envelope(
  routingKey: string,
  payload: Record<string, unknown>,
  tenantId: string | null = SANTA_LUZIA,
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: EVENT,
    eventType: 'MembershipRevoked',
    routingKey,
    eventVersion: 1,
    occurredAt: '2026-10-15T11:59:59.000Z',
    tenantId,
    aggregateType: 'Membership',
    aggregateId: BRUNO_SANTA_LUZIA,
    processId: null,
    actor: { type: 'USER', userId: BRUNO, membershipId: BRUNO_SANTA_LUZIA },
    correlationId: 'corr-1',
    causationId: null,
    payload,
  };
}

function header(overrides: Partial<SessionHeader> & Pick<SessionHeader, 'key'>): SessionHeader {
  return {
    userId: BRUNO,
    displayName: 'Bruno',
    activeTenantId: SANTA_LUZIA,
    membershipId: BRUNO_SANTA_LUZIA,
    createdAt: NOW.getTime() - 3_600_000,
    lastSeenAt: NOW.getTime() - 60_000,
    idleExpiresAt: NOW.getTime() + 1_740_000,
    absoluteExpiresAt: NOW.getTime() + 39_600_000,
    idleMinutes: 30,
    ...overrides,
  };
}

/** Sessão viva como o BFF a grava: registro com tokens cifrados + os três índices. */
async function seed(redis: MemorySessionRedis, session: SessionHeader): Promise<void> {
  redis.strings.set(
    keys.record(session.key),
    JSON.stringify({ ...session, sealedTokens: 'tokens-cifrados' }),
  );
  await redis.zadd(keys.user(session.userId), session.createdAt, session.key);
  await redis.zadd(keys.expiry, session.idleExpiresAt, session.key);
  if (session.membershipId) await redis.sadd(keys.membership(session.membershipId), session.key);
}

function isAlive(redis: MemorySessionRedis, key: string): boolean {
  return redis.strings.has(keys.record(key));
}

function tombstoneOf(redis: MemorySessionRedis, key: string) {
  return parseSessionTombstone(redis.strings.get(keys.ended(key)) ?? null);
}

class RecordingLogger implements SessionTerminationLogger {
  readonly lines: { level: 'log' | 'warn'; fields: Record<string, unknown>; message: string }[] =
    [];

  log(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'log', fields, message });
  }

  warn(fields: Record<string, unknown>, message: string): void {
    this.lines.push({ level: 'warn', fields, message });
  }
}

function setup() {
  const redis = new MemorySessionRedis();
  const logger = new RecordingLogger();
  const handler = new SessionTerminationHandler(
    new SessionRedis({ redisUrl: '', appEnv: APP_ENV }, redis),
    {
      now: () => NOW,
      logger,
    },
  );
  return { redis, logger, handler };
}

describe('SessionTerminationHandler — encerramento por vínculo (RN-IAM-27)', () => {
  it('[Tenant incorreto] encerra só a sessão da instituição do evento; a de outra continua', async () => {
    const { redis, handler } = setup();
    await seed(
      redis,
      header({
        key: KEY_SAO_JOSE,
        activeTenantId: SAO_JOSE,
        membershipId: BRUNO_SAO_JOSE,
      }),
    );
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));

    await handler.handle(
      envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA }, SANTA_LUZIA),
    );

    // Santa Luzia: registro vivo apagado, registro de encerramento com o motivo, fora dos índices.
    expect(isAlive(redis, KEY_SANTA_LUZIA)).toBe(false);
    expect(tombstoneOf(redis, KEY_SANTA_LUZIA)).toMatchObject({
      key: KEY_SANTA_LUZIA,
      userId: BRUNO,
      activeTenantId: SANTA_LUZIA,
      membershipId: BRUNO_SANTA_LUZIA,
      reason: 'MEMBERSHIP_REVOKED',
      occurredAt: NOW.getTime(),
      ip: null,
      userAgent: null,
    });
    expect(redis.sets.get(keys.membership(BRUNO_SANTA_LUZIA))?.size).toBe(0);
    expect(redis.zsets.get(keys.user(BRUNO))?.has(KEY_SANTA_LUZIA)).toBe(false);
    expect(redis.zsets.get(keys.expiry)?.get(KEY_SANTA_LUZIA)).toBe(NOW.getTime());
    // São José: intacta (registro vivo, índices e nenhum registro de encerramento).
    expect(isAlive(redis, KEY_SAO_JOSE)).toBe(true);
    expect(tombstoneOf(redis, KEY_SAO_JOSE)).toBeNull();
    expect(redis.sets.get(keys.membership(BRUNO_SAO_JOSE))).toEqual(new Set([KEY_SAO_JOSE]));
    expect(redis.zsets.get(keys.user(BRUNO))?.has(KEY_SAO_JOSE)).toBe(true);
  });

  it.each([
    ['membership.suspended', 'MEMBERSHIP_SUSPENDED'],
    ['membership.revoked', 'MEMBERSHIP_REVOKED'],
    ['membership.expired', 'MEMBERSHIP_EXPIRED'],
  ] as const satisfies readonly (readonly [string, SessionEndReason])[])(
    '%s encerra com o motivo %s',
    async (routingKey, reason) => {
      const { redis, handler } = setup();
      await seed(redis, header({ key: KEY_SANTA_LUZIA }));

      await handler.handle(envelope(routingKey, { membershipId: BRUNO_SANTA_LUZIA }));

      expect(isAlive(redis, KEY_SANTA_LUZIA)).toBe(false);
      expect(tombstoneOf(redis, KEY_SANTA_LUZIA)?.reason).toBe(reason);
    },
  );

  it('encerra todas as sessões do vínculo (vários navegadores) e conta no log', async () => {
    const { redis, logger, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));
    await seed(redis, header({ key: KEY_OTHER }));

    await handler.handle(envelope('membership.suspended', { membershipId: BRUNO_SANTA_LUZIA }));

    expect(isAlive(redis, KEY_SANTA_LUZIA) || isAlive(redis, KEY_OTHER)).toBe(false);
    expect(logger.lines).toEqual([
      {
        level: 'log',
        fields: {
          event: 'auth.sessions_terminated',
          membershipId: BRUNO_SANTA_LUZIA,
          reason: 'MEMBERSHIP_SUSPENDED',
          count: 2,
        },
        message: expect.any(String) as string,
      },
    ]);
  });

  it('[Duplicidade] reentrega do mesmo evento não encontra sessões vivas e não falha', async () => {
    const { redis, logger, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));
    const event = envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA });

    await handler.handle(event);
    const tombstone = redis.strings.get(keys.ended(KEY_SANTA_LUZIA));
    await expect(handler.handle(event)).resolves.toBeUndefined();

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.fields.count).toBe(1);
    // O registro de encerramento (que a varredura audita) não foi regravado.
    expect(redis.strings.get(keys.ended(KEY_SANTA_LUZIA))).toBe(tombstone);
  });

  it('entrada órfã ou velha no índice sai do conjunto sem encerrar ninguém', async () => {
    const { redis, logger, handler } = setup();
    const index = keys.membership(BRUNO_SANTA_LUZIA);
    // Órfã: a sessão já foi encerrada (registro vivo ausente).
    await redis.sadd(index, KEY_OTHER);
    // Velha: a sessão trocou para São José depois de indexada em Santa Luzia.
    await seed(
      redis,
      header({ key: KEY_SAO_JOSE, activeTenantId: SAO_JOSE, membershipId: BRUNO_SAO_JOSE }),
    );
    await redis.sadd(index, KEY_SAO_JOSE);
    // Velha por vínculo: mesma instituição, mas a sessão agora usa outro vínculo.
    const KEY_OTHER_MEMBERSHIP = 'd4'.repeat(32);
    await seed(redis, header({ key: KEY_OTHER_MEMBERSHIP, membershipId: BRUNO_SAO_JOSE }));
    await redis.sadd(index, KEY_OTHER_MEMBERSHIP);

    await handler.handle(envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA }));

    expect(redis.sets.get(index)?.size).toBe(0);
    expect(isAlive(redis, KEY_SAO_JOSE)).toBe(true);
    expect(isAlive(redis, KEY_OTHER_MEMBERSHIP)).toBe(true);
    expect(redis.strings.has(keys.ended(KEY_SAO_JOSE))).toBe(false);
    expect(redis.strings.has(keys.ended(KEY_OTHER_MEMBERSHIP))).toBe(false);
    expect(logger.lines).toEqual([]);
  });

  it('payload sem membershipId válido, routing key alheia ou evento de plataforma → nada', async () => {
    const { redis, logger, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));
    const before = new Map(redis.strings);

    await handler.handle(envelope('membership.revoked', {}));
    await handler.handle(envelope('membership.revoked', { membershipId: 'não-é-uuid' }));
    await handler.handle(envelope('membership.revoked', { membershipId: 42 }));
    await handler.handle(envelope('membership.revoked', { membershipId: { $ne: null } }));
    await handler.handle(envelope('membership.activated', { membershipId: BRUNO_SANTA_LUZIA }));
    await handler.handle(envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA }, null));

    expect(redis.strings).toEqual(before);
    expect(redis.sets.get(keys.membership(BRUNO_SANTA_LUZIA))).toEqual(new Set([KEY_SANTA_LUZIA]));
    expect(logger.lines).toEqual([]);
  });

  it('com o Redis fora o erro propaga (o job é repetido pela fila)', async () => {
    const { redis, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));
    redis.down = true;

    await expect(
      handler.handle(envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA })),
    ).rejects.toThrow('ECONNREFUSED');

    // Na repetição, com o Redis de volta, a sessão é encerrada.
    redis.down = false;
    await handler.handle(envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA }));
    expect(isAlive(redis, KEY_SANTA_LUZIA)).toBe(false);
  });

  it('o log não contém a chave da sessão nem o registro dela', async () => {
    const { redis, logger, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));

    await handler.handle(envelope('membership.revoked', { membershipId: BRUNO_SANTA_LUZIA }));

    expect(logger.lines).toHaveLength(1);
    const logged = JSON.stringify(logger.lines);
    expect(logged).toContain('auth.sessions_terminated');
    expect(logged).not.toContain(KEY_SANTA_LUZIA);
    expect(logged).not.toContain('tokens-cifrados');
  });
});

describe('rotas do encerramento por vínculo', () => {
  it('membership.revoked aciona o cache de permissões e o encerramento de sessões', () => {
    expect(resolveRoutes('membership.revoked').inline).toEqual([
      'PermissionCacheInvalidator',
      'SessionTerminationHandler',
    ]);
    for (const routingKey of ['membership.suspended', 'membership.expired']) {
      expect(resolveRoutes(routingKey).inline).toContain('SessionTerminationHandler');
    }
  });

  it('membership.activated (e demais eventos) não encerra sessão', () => {
    expect(resolveRoutes('membership.activated').inline).toEqual(['PermissionCacheInvalidator']);
    expect(resolveRoutes('role.assigned').inline).not.toContain('SessionTerminationHandler');
    expect(
      DOMAIN_EVENT_ROUTES.inline.find((r) => r.handler === 'SessionTerminationHandler'),
    ).toMatchObject({
      match: ['membership.suspended', 'membership.revoked', 'membership.expired'],
    });
  });
});

describe('DomainEventsProcessor com o encerramento de sessões', () => {
  class NoQueues implements FanOutQueues {
    add(_queue: string, _job: FanOutJob): Promise<void> {
      return Promise.resolve();
    }
  }

  const cache = {
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(1),
    deleteByPrefix: () => Promise.resolve(1),
  } as unknown as TenantRedisCache;

  function job(routingKey: string) {
    return {
      meta: {
        schemaVersion: 1,
        tenantId: SANTA_LUZIA,
        actor: { type: 'USER', userId: BRUNO, membershipId: BRUNO_SANTA_LUZIA },
        correlationId: 'corr-1',
        causationId: null,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        enqueuedAt: '2026-10-15T12:00:01.000Z',
      },
      payload: { envelope: envelope(routingKey, { membershipId: BRUNO_SANTA_LUZIA }) },
    };
  }

  it('o job de membership.revoked invalida o cache e encerra a sessão', async () => {
    const { redis, handler } = setup();
    await seed(redis, header({ key: KEY_SANTA_LUZIA }));
    const processor = new DomainEventsProcessor({
      queues: new NoQueues(),
      handlers: [new PermissionCacheInvalidator(cache), handler],
    });

    const result = await processor.process(job('membership.revoked'), EVENT);

    expect(result.inline).toEqual(['PermissionCacheInvalidator', 'SessionTerminationHandler']);
    expect(isAlive(redis, KEY_SANTA_LUZIA)).toBe(false);
  });

  it('sem o Redis de sessões o handler ausente é explícito: avisa uma vez e o job conclui', async () => {
    const logger = new RecordingLogger();
    const processor = new DomainEventsProcessor({
      queues: new NoQueues(),
      handlers: [new PermissionCacheInvalidator(cache), new SessionTerminationDisabled(logger)],
    });

    await processor.process(job('membership.revoked'), EVENT);
    await processor.process(job('membership.suspended'), EVENT);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: 'warn',
      fields: { event: 'auth.session_termination_disabled' },
    });
  });

  it('sem nenhum handler registrado a rota falha em vez de descartar em silêncio', async () => {
    const processor = new DomainEventsProcessor({
      queues: new NoQueues(),
      handlers: [new PermissionCacheInvalidator(cache)],
    });
    await expect(processor.process(job('membership.revoked'), EVENT)).rejects.toThrow(
      /SessionTerminationHandler não registrado/,
    );
  });
});
