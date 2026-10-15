import type { JobMeta } from '@contrataflow/types';
import { domainEventJobSchema } from '@contrataflow/validation';
import type { DomainEventJobData } from '@contrataflow/validation';
import { UnrecoverableError } from 'bullmq';

import type { InlineEventHandler } from './inline-handlers.js';
import { DOMAIN_EVENT_ROUTES, resolveRoutes } from './routes.js';
import type { DomainEventRoutes, FanOutQueue, InlineHandlerName } from './routes.js';

/** Job filho de uma fila consumidora: `jobId = eventId` (único por fila — queues.md §7.3). */
export interface FanOutJob {
  readonly jobId: string;
  readonly data: DomainEventJobData;
}

/** Enfileiramento nas filas consumidoras (BullMQ em produção; em memória nos testes). */
export interface FanOutQueues {
  add(queue: FanOutQueue, job: FanOutJob): Promise<void>;
}

export interface FanOutResult {
  readonly queues: readonly FanOutQueue[];
  readonly inline: readonly InlineHandlerName[];
}

export interface DomainEventsProcessorDeps {
  readonly queues: FanOutQueues;
  readonly handlers: readonly InlineEventHandler[];
  readonly routes?: DomainEventRoutes;
  readonly now?: () => Date;
}

/**
 * `DomainEventsProcessor` (US-082 · RN-FND-58 · queues.md §7.3): consome `domain-events`, valida
 * `meta` + envelope (inválido → `UnrecoverableError`, sem retry), enfileira o evento em cada fila
 * assinante com `jobId = eventId` e executa os handlers leves idempotentes. Reexecução é segura:
 * filhos já criados são deduplicados pelo `jobId` e os handlers deduplicam por `eventId`.
 * O router não contém lógica de negócio.
 */
export class DomainEventsProcessor {
  private readonly handlers: ReadonlyMap<InlineHandlerName, InlineEventHandler>;
  private readonly routes: DomainEventRoutes;
  private readonly now: () => Date;

  constructor(private readonly deps: DomainEventsProcessorDeps) {
    this.handlers = new Map(deps.handlers.map((handler) => [handler.name, handler]));
    this.routes = deps.routes ?? DOMAIN_EVENT_ROUTES;
    this.now = deps.now ?? (() => new Date());
  }

  async process(data: unknown, jobId: string | undefined): Promise<FanOutResult> {
    const parsed = domainEventJobSchema.safeParse(data);
    if (!parsed.success) {
      throw new UnrecoverableError('domain-events: job fora do contrato (meta/envelope)');
    }
    const { meta, payload } = parsed.data;
    const { envelope } = payload;
    if (jobId !== envelope.eventId) {
      throw new UnrecoverableError('domain-events: jobId diferente do eventId');
    }
    const targets = resolveRoutes(envelope.routingKey, this.routes);

    // Filhos herdam tenant, ator, correlação e trace; a causa passa a ser o próprio evento.
    const childMeta: JobMeta = {
      ...meta,
      causationId: envelope.eventId,
      enqueuedAt: this.now().toISOString(),
    };
    for (const queue of targets.queues) {
      await this.deps.queues.add(queue, {
        jobId: envelope.eventId,
        data: { meta: childMeta, payload: { envelope } },
      });
    }
    for (const name of targets.inline) {
      const handler = this.handlers.get(name);
      if (!handler) throw new Error(`domain-events: handler leve ${name} não registrado`);
      await handler.handle(envelope);
    }
    return targets;
  }
}
