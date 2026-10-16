import { randomUUID } from 'node:crypto';

import type { DomainEventEnvelope } from '@contrataflow/types';
import { UserInvited } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import type { TenantRedisCache } from '#shared/cache/tenant-redis.js';

import type { InlineHandlerName } from './routes.js';
import type { JobProducer } from '../queues/job-producer.js';

/** Handler leve e idempotente executado no job do `domain-events` (queues.md §4.1). */
export interface InlineEventHandler {
  readonly name: InlineHandlerName;
  handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void>;
}

/** Deduplicação por `eventId` dos efeitos não transacionais (queues.md §8, camada 4). */
export const DEDUPE_TTL_SECONDS = 24 * 3_600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Os tokens de geração vivem mais que qualquer retrato do cache (5 min) — US-097. */
const PERMISSION_GENERATION_TTL_SECONDS = 24 * 3_600;

/**
 * Invalida o cache de permissões efetivas (permissions.md §1.2 · RN-IAM-102): troca o token de
 * geração e faz `DEL` da chave do vínculo do payload (`membershipId`) ou, sem ele (perfil alterado,
 * unidade movida), troca o token do tenant e apaga todas as chaves do tenant. O token faz a API
 * descartar retrato calculado antes da mudança e gravado depois do `DEL` (US-097 · Concorrência).
 * Idempotente — reentrega só repete a troca e o `DEL`.
 */
export class PermissionCacheInvalidator implements InlineEventHandler {
  readonly name = 'PermissionCacheInvalidator';

  constructor(private readonly cache: TenantRedisCache) {}

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    if (event.tenantId === null) return;
    const membershipId = event.payload.membershipId;
    if (typeof membershipId === 'string' && UUID.test(membershipId)) {
      await this.cache.set(
        event.tenantId,
        ['access', 'eff-gen', membershipId],
        randomUUID(),
        PERMISSION_GENERATION_TTL_SECONDS,
      );
      await this.cache.delete(event.tenantId, ['access', 'eff', membershipId]);
      return;
    }
    await this.cache.set(
      event.tenantId,
      ['access', 'eff-gen'],
      randomUUID(),
      PERMISSION_GENERATION_TTL_SECONDS,
    );
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
 * Prefixos de chaves de configuração apagados em bloco: o calendário é guardado por ano
 * (`catalog:holidays:{year}` — architecture.md §6.3), e o feriado alterado pode estar em qualquer
 * um (US-106).
 */
const CONFIG_CACHE_PREFIXES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'catalog.holiday_changed': [['catalog', 'holidays']],
  // US-040: a definição de cada versão é imutável (`workflow:def:{versionId}` nunca fica velha);
  // o que muda na publicação/aposentadoria é o conjunto de versões vigentes do tenant.
  'workflow.version_published': [['workflow', 'applicable']],
  'workflow.version_retired': [['workflow', 'applicable']],
  // US-042: a troca do padrão (WF-05) muda qual workflow a resolução devolve.
  'workflow.default_changed': [['workflow', 'applicable']],
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
    for (const segments of CONFIG_CACHE_PREFIXES[event.routingKey] ?? []) {
      await this.cache.deleteByPrefix(event.tenantId, segments);
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

/**
 * Enfileirador do e-mail do convite (US-091 · queues.md §4.3): em `membership.invited`
 * (`UserInvited` — convite, reenvio e convite do primeiro administrador), enfileira o job
 * `email/send` com a referência do vínculo; o `EmailSender` gera o link e envia. O `jobId` é o
 * `eventId` puro (o BullMQ não aceita ':' em jobId customizado): a reentrega do mesmo evento é
 * deduplicada pela fila. O `meta` do job sai do job de `domain-events` em execução (tenant do
 * evento, ator, correlação) pelo `JobProducer`.
 */
export class InvitationEmailEnqueuer implements InlineEventHandler {
  readonly name = 'InvitationEmailEnqueuer';
  private readonly logger = new Logger('InvitationEmailEnqueuer');

  constructor(private readonly producer: Pick<JobProducer, 'enqueue'>) {}

  async handle(event: DomainEventEnvelope<Record<string, unknown>>): Promise<void> {
    if (event.tenantId === null) {
      this.logger.warn({ event: 'invitation.email_no_tenant', eventId: event.eventId });
      return;
    }
    const payload = UserInvited.payloadSchema.safeParse(event.payload);
    if (!payload.success) {
      this.logger.warn({ event: 'invitation.email_bad_payload', eventId: event.eventId });
      return;
    }
    await this.producer.enqueue(
      'email',
      'send',
      { kind: 'INVITATION', membershipId: payload.data.membershipId },
      { jobId: event.eventId },
    );
  }
}
