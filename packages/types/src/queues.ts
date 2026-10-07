/**
 * Nomes das filas BullMQ (kebab-case — DEC-001; docs/architecture/queues.md).
 * Preenchido pelas stories donas de cada fila.
 */
export const QUEUE_NAMES = [] as const satisfies readonly string[];

export type QueueName = (typeof QUEUE_NAMES)[number];
