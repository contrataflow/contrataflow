/**
 * Nomes dos eventos de domínio (PascalCase no passado — DEC-001; routing keys em DEC-162).
 * Preenchido pelas stories donas de cada evento a partir de docs/mvp-01/events.md; cada nome tem
 * a definição (schema do payload e routing key) em `@contrataflow/validation` e uma decisão de
 * roteamento no worker (V-03 da US-082 — testes nos dois pacotes).
 */
export const DOMAIN_EVENT_NAMES = [
  'DocumentTypeChanged',
  'OrganizationCreated',
  'OrganizationUpdated',
  'TenantProvisioned',
  'TenantActivated',
  'TenantSuspended',
  'TenantOffboarded',
  'TenantDeactivated',
  'TenantSettingsChanged',
  'CatalogItemChanged',
  'HolidayChanged',
  'WorkflowCreated',
  'WorkflowVersionPublished',
  'WorkflowVersionRetired',
  'RoleCreated',
  'RoleUpdated',
] as const satisfies readonly string[];

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];

/** Quem originou o fato (entities.md §2 `ActorType`; DEC-160). */
export const EVENT_ACTOR_TYPES = ['USER', 'SYSTEM', 'PLATFORM_OPERATOR', 'INTEGRATION'] as const;

export type EventActorType = (typeof EVENT_ACTOR_TYPES)[number];

export interface EventActor {
  readonly type: EventActorType;
  readonly userId: string | null;
  readonly membershipId: string | null;
}

/**
 * Envelope único de evento de domínio (DEC-160 · queues.md §6.1). `traceparent` não faz parte do
 * envelope: é metadado técnico de `outbox_events.metadata` e do `JobMeta`.
 */
export interface DomainEventEnvelope<P = unknown> {
  /** UUIDv7 (= `outbox_events.id` = `jobId` na fila `domain-events`). */
  readonly eventId: string;
  readonly eventType: string;
  readonly routingKey: string;
  readonly eventVersion: number;
  /** ISO 8601 UTC. */
  readonly occurredAt: string;
  /** Nulo só em eventos de plataforma. */
  readonly tenantId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly processId: string | null;
  readonly actor: EventActor;
  readonly correlationId: string;
  /** `eventId` que causou este fato (caso de uso disparado por outro evento). */
  readonly causationId: string | null;
  /** Só IDs e o mínimo necessário; nunca dado sigiloso (events.md §1 · POL-09). */
  readonly payload: P;
}

/** Situação de uma linha de `outbox_events` (entities.md §1 · DEC-161). */
export const OUTBOX_STATUSES = ['PENDING', 'PUBLISHED', 'FAILED'] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Limite do payload serializado de um evento (queues.md §2 — payload de job ≤ 16 KB). */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

/** Canal do `pg_notify` emitido na transação que grava o evento (ADR-004). */
export const OUTBOX_NOTIFY_CHANNEL = 'cf_outbox';
