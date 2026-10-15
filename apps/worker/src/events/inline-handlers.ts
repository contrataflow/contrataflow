import type { DomainEventEnvelope } from '@contrataflow/types';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import type { TenantRedisCache } from '#shared/cache/tenant-redis.js';

import type { InlineHandlerName } from './routes.js';

/** Handler leve e idempotente executado no job do `domain-events` (queues.md §4.1). */
export interface InlineEventHandler {
  readonly name: InlineHandlerName;
  handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void>;
}

/** Deduplicação por `eventId` dos efeitos não transacionais (queues.md §8, camada 4). */
export const DEDUPE_TTL_SECONDS = 24 * 3_600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Invalida o cache de permissões efetivas (permissions.md §1.2): `DEL` da chave do vínculo do
 * payload (`membershipId`) ou, sem ele (perfil alterado, unidade movida), de todas as chaves do
 * tenant. Idempotente por natureza — reentrega só repete o DEL.
 */
export class PermissionCacheInvalidator implements InlineEventHandler {
  readonly name = 'PermissionCacheInvalidator';

  constructor(private readonly cache: TenantRedisCache) {}

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    if (event.tenantId === null) return;
    const membershipId = event.payload.membershipId;
    if (typeof membershipId === 'string' && UUID.test(membershipId)) {
      await this.cache.delete(event.tenantId, ['access', 'eff', membershipId]);
      return;
    }
    await this.cache.deleteByPrefix(event.tenantId, ['access', 'eff']);
  }
}

/**
 * Chaves de cache de configuração do tenant apagadas por routing key (events.md §3, legenda C):
 * os segmentos seguem `TenantCache` da api (`cf:{env}:t:{tenantId}:{módulo}:{chave}`). Eventos de
 * configuração novos entram aqui com a story que os publica (US-061: tipos de documento).
 */
const CONFIG_CACHE_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'document_type.changed': [['document', 'types']],
  // US-104: listas de catálogo em cache por tenant (seletores dos formulários).
  'catalog.item_changed': [['catalog', 'items']],
};

/**
 * `ConfigCacheInvalidator`: `DEL` das chaves de configuração do tenant do evento. Idempotente por
 * natureza — reentrega só repete o DEL; se o Redis falha, o job é repetido pela fila e, no pior
 * caso, o cache expira pelo TTL (US-061 · RN-DOC-12).
 */
export class ConfigCacheInvalidator implements InlineEventHandler {
  readonly name = 'ConfigCacheInvalidator';

  constructor(private readonly cache: TenantRedisCache) {}

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    if (event.tenantId === null) return;
    for (const segments of CONFIG_CACHE_KEYS[event.routingKey] ?? []) {
      await this.cache.delete(event.tenantId, segments);
    }
  }
}

let businessEvents: Counter | undefined;

/**
 * Contadores de negócio (events.md §3): `cf_business_events_total{event_type,routing_key}`,
 * tolerantes a reentrega — só conta a primeira entrega de cada `eventId` em 24 h (SET NX).
 */
export class BusinessMetricsCollector implements InlineEventHandler {
  readonly name = 'BusinessMetricsCollector';

  constructor(private readonly cache: TenantRedisCache) {}

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    const first = await this.cache.setOnce(
      event.tenantId,
      ['evt', this.name, event.eventId],
      DEDUPE_TTL_SECONDS,
    );
    if (!first) return;
    businessEvents ??= metrics
      .getMeter('contrataflow-worker')
      .createCounter('cf_business_events_total', {
        description: 'Fatos de negócio publicados (uma vez por eventId), por tipo.',
      });
    businessEvents.add(1, { event_type: event.eventType, routing_key: event.routingKey });
  }
}
