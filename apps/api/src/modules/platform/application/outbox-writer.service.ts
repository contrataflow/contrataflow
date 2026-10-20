import { injectTraceCarrier } from '@contrataflow/observability';
import type { EventActor } from '@contrataflow/types';
import { DomainEventContractError, domainEventEnvelopeSchema } from '@contrataflow/validation';
import type { DomainEventDraft, ResolvedDomainEvent } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';
import { isActiveTransaction } from '#shared/database/active-transaction.js';
import { isUuid, newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { OutboxWriterPort, RecordedDomainEvent } from '#shared/outbox/outbox-writer.js';

import { OUTBOX_STORE, OutboxContractError } from './outbox-ports.js';
import type { OutboxMetadata, OutboxStore } from './outbox-ports.js';
import { SyncEventHandlerRegistry } from './sync-event-handler.registry.js';

let recordedCounter: Counter | undefined;

/** `cf_outbox_recorded_total{event_type}` — eventos gravados (no-op até a US-085). */
function recordedTotal(): Counter {
  recordedCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('cf_outbox_recorded_total', {
      description: 'Eventos de domínio gravados no outbox na transação do caso de uso (US-082).',
    });
  return recordedCounter;
}

/** Tenant e ator do contexto (o envelope nunca é montado à mão — DEC-164). */
function originOf(context: RequestContext): { tenantId: string; actor: EventActor } {
  const tenantId = context.tenantId;
  if (tenantId === null || !isUuid(tenantId)) {
    throw new OutboxContractError('CONTEXT', 'evento de domínio exige o tenant do contexto.');
  }
  const { type, userId, membershipId } = context.actor;
  if (type === 'ANONYMOUS') {
    throw new OutboxContractError('CONTEXT', 'evento de domínio exige um ator autenticado.');
  }
  return { tenantId, actor: { type, userId, membershipId } };
}

function resolve(event: DomainEventDraft): ResolvedDomainEvent {
  try {
    return event.definition.resolve(event.payload);
  } catch (error) {
    if (error instanceof DomainEventContractError) {
      throw new OutboxContractError('V-02', error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * `OutboxWriter` (US-082 · RN-FND-49..53): grava o evento de domínio na transação do caso de uso
 * e executa os handlers síncronos no mesmo `tx`. A auditoria NÃO passa por aqui — o caso de uso a
 * grava explicitamente pelo `AuditService` (RN-FND-53).
 */
@Injectable()
export class OutboxWriterService implements OutboxWriterPort {
  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    private readonly handlers: SyncEventHandlerRegistry,
  ) {}

  async record(tx: TenantTx, event: DomainEventDraft): Promise<RecordedDomainEvent> {
    const recorded = await this.write(tx, event, newId(), false);
    if (recorded === null) throw new Error('INSERT em outbox_events sem linha gravada.');
    return recorded;
  }

  recordOnce(
    tx: TenantTx,
    event: DomainEventDraft,
    eventId: string,
  ): Promise<RecordedDomainEvent | null> {
    return this.write(tx, event, eventId, true);
  }

  private async write(
    tx: TenantTx,
    event: DomainEventDraft,
    eventId: string,
    once: boolean,
  ): Promise<RecordedDomainEvent | null> {
    if (!isActiveTransaction(tx)) {
      throw new OutboxContractError(
        'TRANSACTION',
        'OutboxWriter.record exige o tx da transação ativa do caso de uso.',
      );
    }
    const context = requireRequestContext();
    const { tenantId, actor } = originOf(context);
    const resolved = resolve(event);

    // V-01: o envelope completo (com um instante provisório; o definitivo vem do banco).
    const draft = domainEventEnvelopeSchema.safeParse({
      eventId,
      eventType: resolved.eventType,
      routingKey: resolved.routingKey,
      eventVersion: resolved.eventVersion,
      occurredAt: new Date().toISOString(),
      tenantId,
      aggregateType: resolved.aggregateType,
      aggregateId: event.aggregateId,
      processId: event.processId,
      actor,
      correlationId: context.correlationId,
      causationId: event.causationId,
      payload: resolved.payload,
    });
    if (!draft.success) {
      const issues = draft.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`);
      throw new OutboxContractError(
        'V-01',
        `envelope de ${resolved.eventType} inválido: ${issues.join('; ')}`,
      );
    }
    const envelope = draft.data;

    const metadata: OutboxMetadata = {
      actor,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      ...injectTraceCarrier(),
    };
    const row = {
      id: envelope.eventId,
      tenantId,
      eventType: envelope.eventType,
      routingKey: envelope.routingKey,
      eventVersion: envelope.eventVersion,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      processId: envelope.processId,
      payload: envelope.payload,
      metadata,
    };
    const occurredAt = once
      ? await this.store.insertOnce(tx, row)
      : await this.store.insert(tx, row);
    // Fato com chave natural já gravado (`recordOnce`): nada a despachar.
    if (occurredAt === null) return null;
    const recorded: RecordedDomainEvent = { ...envelope, occurredAt: occurredAt.toISOString() };

    await this.handlers.dispatch(tx, recorded);
    recordedTotal().add(1, { event_type: recorded.eventType });
    return recorded;
  }
}
