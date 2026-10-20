import { MAX_EVENT_PAYLOAD_BYTES } from '@contrataflow/types';
import type { JobMeta } from '@contrataflow/types';
import {
  domainEventEnvelopeSchema,
  eventActorSchema,
  eventPayloadBytes,
} from '@contrataflow/validation';
import type { DomainEventJobData } from '@contrataflow/validation';
import { z } from 'zod';

/** Linha `PENDING` lida pelo relay (colunas de queues.md §5.3). */
export interface OutboxRecord {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly event_type: string;
  readonly routing_key: string;
  readonly event_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly process_id: string | null;
  readonly payload: unknown;
  readonly metadata: unknown;
  readonly occurred_at: Date;
  readonly attempts: number;
}

/** Metadados técnicos gravados pelo `OutboxWriter` (ator, correlação, causa e trace). */
const metadataSchema = z.object({
  actor: eventActorSchema,
  correlationId: z.string().min(1).max(64),
  causationId: z.uuid().nullable(),
  traceparent: z.string().max(55).optional(),
  tracestate: z.string().max(512).optional(),
});

export interface PublishableEvent {
  /** `jobId` = `eventId` (deduplicação natural do BullMQ — RN-FND-55). */
  readonly jobId: string;
  readonly data: DomainEventJobData;
  readonly occurredAt: Date;
  readonly eventType: string;
}

export type OutboxRecordCheck =
  | { readonly ok: true; readonly event: PublishableEvent }
  /** Linha inválida (V-04): vai para backoff isolado; `reason` nunca traz valores do payload. */
  | { readonly ok: false; readonly reason: string };

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.code}`)
    .join('; ');
}

/**
 * Monta o job da fila `domain-events` a partir da linha (queues.md §4.1/§9.1): envelope DEC-160
 * das colunas e `JobMeta` de `metadata` — `traceparent` vai para o meta, nunca para o envelope.
 */
export function toPublishableEvent(record: OutboxRecord, enqueuedAt: Date): OutboxRecordCheck {
  if (eventPayloadBytes(record.payload) > MAX_EVENT_PAYLOAD_BYTES) {
    return { ok: false, reason: `payload acima de ${String(MAX_EVENT_PAYLOAD_BYTES)} bytes` };
  }
  const metadata = metadataSchema.safeParse(record.metadata);
  if (!metadata.success)
    return { ok: false, reason: `metadata inválido: ${issues(metadata.error)}` };
  const envelope = domainEventEnvelopeSchema.safeParse({
    eventId: record.id,
    eventType: record.event_type,
    routingKey: record.routing_key,
    eventVersion: record.event_version,
    occurredAt: record.occurred_at.toISOString(),
    tenantId: record.tenant_id,
    aggregateType: record.aggregate_type,
    aggregateId: record.aggregate_id,
    processId: record.process_id,
    actor: metadata.data.actor,
    correlationId: metadata.data.correlationId,
    causationId: metadata.data.causationId,
    payload: record.payload,
  });
  if (!envelope.success)
    return { ok: false, reason: `envelope inválido: ${issues(envelope.error)}` };

  const { traceparent, tracestate } = metadata.data;
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId: record.tenant_id,
    actor: metadata.data.actor,
    correlationId: metadata.data.correlationId,
    causationId: metadata.data.causationId,
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
    enqueuedAt: enqueuedAt.toISOString(),
  };
  return {
    ok: true,
    event: {
      jobId: record.id,
      data: { meta, payload: { envelope: envelope.data } },
      occurredAt: record.occurred_at,
      eventType: record.event_type,
    },
  };
}
