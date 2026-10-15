import { DOMAIN_EVENT_NAMES } from '@contrataflow/types';
import type { DomainEventEnvelope } from '@contrataflow/types';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { TenantRedisCache } from '#shared/cache/tenant-redis.js';

import { DomainEventsProcessor } from './domain-events.processor.js';
import type { FanOutJob, FanOutQueues } from './domain-events.processor.js';
import {
  BusinessMetricsCollector,
  ConfigCacheInvalidator,
  PermissionCacheInvalidator,
} from './inline-handlers.js';
import type { InlineEventHandler } from './inline-handlers.js';
import { DOMAIN_EVENT_ROUTES, ROUTING_DECISIONS, resolveRoutes } from './routes.js';
import type { FanOutQueue, InlineHandlerName } from './routes.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const USER = '0192f000-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0192f000-0000-7000-8000-0000000000c1';
const EVENT = '0192f3a0-5c1e-7a2b-9c3d-4e5f60718293';

function envelope(
  routingKey: string,
  payload: Record<string, unknown> = {},
): DomainEventEnvelope<Record<string, unknown>> {
  return {
    eventId: EVENT,
    eventType: 'ProcessStageChanged',
    routingKey,
    eventVersion: 1,
    occurredAt: '2026-10-15T12:00:00.000Z',
    tenantId: TENANT,
    aggregateType: 'Process',
    aggregateId: USER,
    processId: USER,
    actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
    correlationId: 'corr-1',
    causationId: null,
    payload,
  };
}

function job(routingKey: string, payload: Record<string, unknown> = {}) {
  return {
    meta: {
      schemaVersion: 1,
      tenantId: TENANT,
      actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
      correlationId: 'corr-1',
      causationId: null,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      enqueuedAt: '2026-10-15T12:00:01.000Z',
    },
    payload: { envelope: envelope(routingKey, payload) },
  };
}

/** Filas com deduplicação por (fila, jobId), como o BullMQ. */
class MemoryQueues implements FanOutQueues {
  readonly jobs = new Map<string, FanOutJob>();

  add(queue: FanOutQueue, fanOutJob: FanOutJob): Promise<void> {
    const key = `${queue}:${fanOutJob.jobId}`;
    if (!this.jobs.has(key)) this.jobs.set(key, fanOutJob);
    return Promise.resolve();
  }
}

/** Redis em memória com a mesma montagem de chave e semântica de TTL ignorada. */
class MemoryCache {
  readonly keys = new Set<string>();
  readonly deleted: string[] = [];

  setOnce(tenantId: string | null, segments: readonly string[]): Promise<boolean> {
    const key = `${tenantId ?? 'p'}:${segments.join(':')}`;
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }

  delete(tenantId: string, segments: readonly string[]): Promise<number> {
    this.deleted.push(`${tenantId}:${segments.join(':')}`);
    return Promise.resolve(1);
  }

  deleteByPrefix(tenantId: string, segments: readonly string[]): Promise<number> {
    this.deleted.push(`${tenantId}:${segments.join(':')}:*`);
    return Promise.resolve(2);
  }
}

function setup() {
  const queues = new MemoryQueues();
  const cache = new MemoryCache();
  const redis = cache as unknown as TenantRedisCache;
  const processor = new DomainEventsProcessor({
    queues,
    handlers: [new PermissionCacheInvalidator(redis), new BusinessMetricsCollector(redis)],
    now: () => new Date('2026-10-15T12:00:02.000Z'),
  });
  return { queues, cache, processor };
}

describe('DomainEventsProcessor — fan-out por routing key (RN-FND-58)', () => {
  it('enfileira em notifications com jobId = eventId e roda os handlers leves que casam', async () => {
    const { queues, cache, processor } = setup();

    const result = await processor.process(
      job('role.assigned', { membershipId: MEMBERSHIP }),
      EVENT,
    );

    expect(result).toEqual({
      queues: ['notifications'],
      inline: ['PermissionCacheInvalidator'],
    });
    const child = queues.jobs.get(`notifications:${EVENT}`);
    expect(child?.jobId).toBe(EVENT);
    expect(child?.data.meta).toMatchObject({
      tenantId: TENANT,
      correlationId: 'corr-1',
      causationId: EVENT,
      enqueuedAt: '2026-10-15T12:00:02.000Z',
    });
    expect(child?.data.payload.envelope.eventId).toBe(EVENT);
    expect(cache.deleted).toEqual([`${TENANT}:access:eff:${MEMBERSHIP}`]);
  });

  it('[Duplicidade] reentrega do mesmo evento não duplica filhos nem métricas', async () => {
    const { queues, cache, processor } = setup();
    const data = job('process.stage_changed.forward');

    await processor.process(data, EVENT);
    await processor.process(data, EVENT);

    expect([...queues.jobs.keys()]).toEqual([`notifications:${EVENT}`]);
    expect([...cache.keys]).toEqual([`${TENANT}:evt:BusinessMetricsCollector:${EVENT}`]);
  });

  it('evento sem assinante só conclui', async () => {
    const { queues, processor } = setup();
    expect(await processor.process(job('catalog.item_created'), EVENT)).toEqual({
      queues: [],
      inline: [],
    });
    expect(queues.jobs.size).toBe(0);
  });

  it('invalida todas as permissões do tenant quando o payload não traz o vínculo', async () => {
    const { cache, processor } = setup();
    await processor.process(job('department.moved'), EVENT);
    expect(cache.deleted).toEqual([`${TENANT}:access:eff:*`]);
  });

  it('job fora do contrato ou com jobId diferente do eventId é erro permanente', async () => {
    const { processor } = setup();
    await expect(processor.process({ meta: {}, payload: {} }, EVENT)).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(processor.process(job('process.created'), 'outro')).rejects.toThrow(
      /jobId diferente/,
    );
  });

  it('rota para handler não registrado falha (configuração inconsistente)', async () => {
    const processor = new DomainEventsProcessor({ queues: new MemoryQueues(), handlers: [] });
    await expect(processor.process(job('process.created'), EVENT)).rejects.toThrow(
      /BusinessMetricsCollector não registrado/,
    );
  });
});

describe('handlers leves', () => {
  it('PermissionCacheInvalidator ignora evento de plataforma', async () => {
    const cache = new MemoryCache();
    const handler: InlineEventHandler = new PermissionCacheInvalidator(
      cache as unknown as TenantRedisCache,
    );
    await handler.handle({ ...envelope('role.assigned'), tenantId: null });
    expect(cache.deleted).toEqual([]);
  });
});

describe('ConfigCacheInvalidator (US-061 · RN-DOC-12)', () => {
  const handlerOf = (cache: MemoryCache) =>
    new ConfigCacheInvalidator(cache as unknown as TenantRedisCache);

  it('document_type.changed apaga a chave de tipos do tenant do evento, sem fila nem métrica', async () => {
    const cache = new MemoryCache();
    const processor = new DomainEventsProcessor({
      queues: new MemoryQueues(),
      handlers: [handlerOf(cache)],
    });
    const result = await processor.process(job('document_type.changed'), EVENT);
    expect(result).toEqual({ queues: [], inline: ['ConfigCacheInvalidator'] });
    expect(cache.deleted).toEqual([`${TENANT}:document:types`]);
  });

  it('é idempotente (reentrega só repete o DEL) e ignora evento de plataforma', async () => {
    const cache = new MemoryCache();
    const handler = handlerOf(cache);
    await handler.handle(envelope('document_type.changed'));
    await handler.handle(envelope('document_type.changed'));
    await handler.handle({ ...envelope('document_type.changed'), tenantId: null });
    expect(cache.deleted).toEqual([`${TENANT}:document:types`, `${TENANT}:document:types`]);
  });
});

describe('rotas (queues.md §7.2 · V-03)', () => {
  it('cada fila recebe no máximo um job por evento', () => {
    const routes = {
      queues: [
        { match: ['process.*'], queue: 'notifications' as const },
        { match: ['process.assigned'], queue: 'notifications' as const },
      ],
      inline: [],
    };
    expect(resolveRoutes('process.assigned', routes).queues).toEqual(['notifications']);
  });

  it('padrões das rotas seguem a convenção de routing key', () => {
    const patterns = [
      ...DOMAIN_EVENT_ROUTES.queues.flatMap((route) => route.match),
      ...DOMAIN_EVENT_ROUTES.inline.flatMap((route) => route.match),
    ];
    for (const pattern of patterns) {
      expect(pattern).toMatch(/^[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|\*))+$/);
    }
  });

  it('todo evento registrado tem decisão de roteamento explícita e coberta pelas rotas', () => {
    expect(Object.keys(ROUTING_DECISIONS).sort()).toEqual([...DOMAIN_EVENT_NAMES].sort());
    for (const decision of Object.values(ROUTING_DECISIONS)) {
      if (decision === 'NO_ASYNC_CONSUMER') continue;
      for (const routingKey of decision) {
        const targets = resolveRoutes(routingKey);
        const handlers: readonly InlineHandlerName[] = targets.inline;
        expect(targets.queues.length + handlers.length).toBeGreaterThan(0);
      }
    }
  });
});
