/**
 * Nomes das filas BullMQ (kebab-case — DEC-001; docs/architecture/queues.md).
 * Preenchido pelas stories donas de cada fila: `domain-events` (relay do outbox) e
 * `notifications` (destino do fan-out) chegam com a US-082.
 */
export const QUEUE_NAMES = ['domain-events', 'notifications'] as const satisfies readonly string[];

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Fila em que o relay do outbox publica cada evento com `jobId = eventId` (queues.md §4.1). */
export const DOMAIN_EVENTS_QUEUE = 'domain-events' satisfies QueueName;

/** Contrato comum de todo job (DEC-164 · queues.md §3). */
export interface JobMeta {
  readonly schemaVersion: 1;
  /** Nulo só em jobs de plataforma explicitamente marcados (queues.md §9.3). */
  readonly tenantId: string | null;
  readonly actor: {
    readonly type: 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR' | 'INTEGRATION';
    readonly userId: string | null;
    readonly membershipId: string | null;
  };
  readonly correlationId: string;
  /** `eventId` que originou o job, quando houver. */
  readonly causationId: string | null;
  /** W3C Trace Context. */
  readonly traceparent?: string | undefined;
  readonly tracestate?: string | undefined;
  /** ISO 8601 UTC. */
  readonly enqueuedAt: string;
}

export interface JobData<P> {
  readonly meta: JobMeta;
  readonly payload: P;
}
