import { DOMAIN_EVENTS_QUEUE } from '@contrataflow/types';
import { Queue } from 'bullmq';

import type { PublishableEvent } from './outbox-record.js';
import { DEFAULT_JOB_OPTIONS, producerConnection, queuePrefix } from '../queues/queue-options.js';

/** Nome do job dentro da fila `domain-events` (kebab-case — queues.md §1.2). */
export const DOMAIN_EVENT_JOB = 'event';

/** Publicação de um lote na fila `domain-events` (atômica: todos ou nenhum). */
export interface DomainEventsPublisher {
  publish(events: readonly PublishableEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** O Redis não confirmou o `addBulk` a tempo: o lote é desfeito e repetido (FA-01). */
export class PublishTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`addBulk sem confirmação em ${String(timeoutMs)} ms`);
    this.name = 'PublishTimeoutError';
  }
}

export interface BullPublisherOptions {
  readonly redisUrl: string;
  readonly appEnv: string;
  /** Espera máxima pela confirmação do Redis (as travas do lote ficam presas enquanto isso). */
  readonly timeoutMs?: number;
}

/**
 * `addBulk` (MULTI/EXEC) com `jobId = eventId` (RN-FND-55): reenviar a mesma linha é absorvido
 * pela deduplicação do BullMQ enquanto o job existir (24 h após concluir — DEC-163).
 */
export class BullDomainEventsPublisher implements DomainEventsPublisher {
  private readonly queue: Queue;
  private readonly timeoutMs: number;

  constructor(options: BullPublisherOptions) {
    this.queue = new Queue(DOMAIN_EVENTS_QUEUE, {
      connection: producerConnection(options.redisUrl),
      prefix: queuePrefix(options.appEnv),
    });
    // Queda do Redis: o erro chega pelo `addBulk` rejeitado; o evento só evita o crash.
    this.queue.on('error', () => undefined);
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async publish(events: readonly PublishableEvent[]): Promise<void> {
    if (events.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PublishTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([
        this.queue.addBulk(
          events.map((event) => ({
            name: DOMAIN_EVENT_JOB,
            data: event.data,
            opts: { ...DEFAULT_JOB_OPTIONS, jobId: event.jobId },
          })),
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
