import { domainEventJobSchema } from '@contrataflow/validation';
import type { DomainEventJobData } from '@contrataflow/validation';

import type { DomainEventsProcessor } from './domain-events.processor.js';
import { DOMAIN_EVENT_JOB } from '../outbox/domain-events.publisher.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

type Payload = DomainEventJobData['payload'];

/**
 * Consumidor de `domain-events` pelo contrato comum (US-083): o `runJob` valida `meta`/payload,
 * abre o contexto e trata retries/dead-letter; o `DomainEventsProcessor` (US-082) faz o fan-out e
 * os handlers leves. Evento de plataforma (`tenantId` nulo no envelope) dispensa tenant; os
 * handlers leves rodam qualquer que seja o status do tenant (invalidam caches na suspensão).
 */
export class DomainEventsJobHandler implements JobHandler<Payload> {
  readonly queue = 'domain-events' as const;
  readonly name = DOMAIN_EVENT_JOB;
  readonly payloadSchema = domainEventJobSchema.shape.payload;
  readonly ignoresTenantStatus = true;

  constructor(private readonly processor: DomainEventsProcessor) {}

  acceptsPlatformContext(payload: Payload): boolean {
    return payload.envelope.tenantId === null;
  }

  async handle(payload: Payload, context: JobHandlerContext): Promise<HandlerResult> {
    await this.processor.process({ meta: context.meta, payload }, context.jobId, context);
    return 'completed';
  }
}
