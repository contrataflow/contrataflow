/**
 * Nomes das filas BullMQ do MVP 1 (kebab-case — DEC-001; docs/architecture/queues.md §4).
 * `domain-events` e `notifications` chegaram com a US-082; as demais, com o worker da US-083.
 */
export const QUEUE_NAMES = [
  'domain-events',
  'notifications',
  'email',
  'document-render',
  'file-scan',
  'deadlines',
  'audit-seal',
  'maintenance',
  'ai-generation',
  'dead-letter',
] as const satisfies readonly string[];

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Fila em que o relay do outbox publica cada evento com `jobId = eventId` (queues.md §4.1). */
export const DOMAIN_EVENTS_QUEUE = 'domain-events' satisfies QueueName;

/** Fila de estacionamento das falhas finais, sem consumidor automático (queues.md §11). */
export const DEAD_LETTER_QUEUE = 'dead-letter' satisfies QueueName;

/**
 * Registro FECHADO de jobs por fila (V-03 · queues.md §4): enfileirar um nome fora dele é recusado
 * no produtor, e um teste do worker reprova handler registrado com nome fora da lista.
 */
export const QUEUE_JOBS = Object.freeze({
  'domain-events': ['event'],
  notifications: ['event'],
  email: ['send'],
  'document-render': ['render'],
  'file-scan': ['scan'],
  deadlines: ['tick', 'scan-tenant'],
  'audit-seal': ['tick', 'seal-tenant', 'seal-platform'],
  maintenance: [
    'daily',
    'reconcile',
    'outbox-purge',
    'processed-events-purge',
    'audit-partitions-ensure',
    'tenant-housekeeping',
  ],
  // DEC-079 · queues.md §4.5.1: `jobId = generationId`, padrão B (enfileirado após o commit).
  'ai-generation': ['generate'],
  'dead-letter': ['dead-letter'],
} as const satisfies Record<QueueName, readonly string[]>);

export type QueueJobName<Q extends QueueName> = (typeof QUEUE_JOBS)[Q][number];

export function isRegisteredJob(queue: string, jobName: string): boolean {
  if (!Object.hasOwn(QUEUE_JOBS, queue)) return false;
  return (QUEUE_JOBS[queue as QueueName] as readonly string[]).includes(jobName);
}

/**
 * Pares fila/job que aceitam `tenantId` nulo (queues.md §9.3 — lista fechada). A `dead-letter`
 * herda o `meta` do job original; o `domain-events` aceita os eventos de plataforma do outbox.
 */
export const PLATFORM_JOBS = Object.freeze({
  deadlines: ['tick'],
  'audit-seal': ['tick', 'seal-platform'],
  maintenance: [
    'daily',
    'reconcile',
    'outbox-purge',
    'processed-events-purge',
    'audit-partitions-ensure',
  ],
  'dead-letter': ['dead-letter'],
} as const satisfies Partial<Record<QueueName, readonly string[]>>);

export function isPlatformJob(queue: string, jobName: string): boolean {
  if (!Object.hasOwn(PLATFORM_JOBS, queue)) return false;
  return (PLATFORM_JOBS[queue as keyof typeof PLATFORM_JOBS] as readonly string[]).includes(
    jobName,
  );
}

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

/** Classe do erro que levou o job à `dead-letter` (queues.md §11.1). */
export const DEAD_LETTER_ERROR_CLASSES = [
  'TRANSIENT_EXHAUSTED',
  'PERMANENT',
  'TIMEOUT',
  'SECURITY',
] as const;
export type DeadLetterErrorClass = (typeof DEAD_LETTER_ERROR_CLASSES)[number];

/** Cópia de um job em falha final na fila `dead-letter` (queues.md §11.1). */
export interface DeadLetterRecord {
  /** `meta` do job original (tenant, ator e correlação); `null` se o próprio `meta` era inválido. */
  readonly meta: JobMeta | null;
  readonly source: {
    readonly queue: string;
    readonly jobName: string;
    readonly jobId: string;
    readonly attemptsMade: number;
    readonly firstEnqueuedAt: string;
    readonly failedAt: string;
  };
  /** Dados originais do job (somente IDs e metadados — queues.md §2). */
  readonly data: unknown;
  readonly error: {
    readonly class: DeadLetterErrorClass;
    readonly name: string;
    readonly code?: string | undefined;
    /** Mensagem sanitizada (DEC-138). */
    readonly message: string;
    /** Truncada em 4 KB. */
    readonly stack?: string | undefined;
  };
}
