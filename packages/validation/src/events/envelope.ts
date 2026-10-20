import { EVENT_ACTOR_TYPES, MAX_EVENT_PAYLOAD_BYTES } from '@contrataflow/types';
import type { DomainEventEnvelope } from '@contrataflow/types';
import { z } from 'zod';

/*
 * Envelope de evento de domínio (DEC-160 · queues.md §6.1 · RN-FND-50): validado pelo
 * `OutboxWriter` antes do commit e pelo relay antes de publicar (V-01/V-04 da US-082). Mensagens
 * técnicas: um envelope inválido é erro de programação, nunca exibido ao usuário.
 */

/** `eventType` em PascalCase no passado (DEC-001). */
export const eventTypeSchema = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]+$/)
  .max(80);

/** `<agregado>.<fato>[.<especialização>]` em snake_case (events.md §1). */
export const routingKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
  .max(120);

/** Tipo do agregado (`Process`, `Document`…) — PascalCase, como em entities.md. */
export const aggregateTypeSchema = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]+$/)
  .max(60);

export const eventActorSchema = z.strictObject({
  type: z.enum(EVENT_ACTOR_TYPES),
  userId: z.uuid().nullable(),
  membershipId: z.uuid().nullable(),
});

export const domainEventEnvelopeSchema = z.strictObject({
  eventId: z.uuidv7(),
  eventType: eventTypeSchema,
  routingKey: routingKeySchema,
  eventVersion: z.int().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  tenantId: z.uuid().nullable(),
  aggregateType: aggregateTypeSchema,
  aggregateId: z.uuid(),
  processId: z.uuid().nullable(),
  actor: eventActorSchema,
  correlationId: z.string().min(1).max(64),
  causationId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<DomainEventEnvelope<Record<string, unknown>>>;

/** Tamanho do payload serializado em bytes (UTF-8). */
export function eventPayloadBytes(payload: unknown): number {
  if (payload === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** `true` se o payload cabe no limite de 16 KB (queues.md §2). */
export function isEventPayloadWithinLimit(payload: unknown): boolean {
  return eventPayloadBytes(payload) <= MAX_EVENT_PAYLOAD_BYTES;
}
