import { runInJobContext } from '@contrataflow/observability';
import type { JobTraceMeta } from '@contrataflow/observability';
import { DOMAIN_EVENTS_QUEUE } from '@contrataflow/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import type { OutboxRuntimeConfig } from '#config/outbox.js';
import { TenantRedisCache } from '#shared/cache/tenant-redis.js';
import { createOutboxDatabase } from '#shared/database/outbox-database.js';
import type { OutboxDatabase } from '#shared/database/outbox-database.js';

import { BullDomainEventsPublisher } from './domain-events.publisher.js';
import { OutboxRelay } from './outbox-relay.js';
import { observeRelayLeader } from './outbox-telemetry.js';
import { BullFanOutQueues } from '../events/bull-fan-out.queues.js';
import { DomainEventsProcessor } from '../events/domain-events.processor.js';
import { BusinessMetricsCollector, PermissionCacheInvalidator } from '../events/inline-handlers.js';
import { backoffStrategy, consumerConnection, queuePrefix } from '../queues/queue-options.js';

export const OUTBOX_RUNTIME_CONFIG = Symbol('OutboxRuntimeConfig');

/** Concorrência do consumidor de `domain-events` por réplica (queues.md §4). */
const DOMAIN_EVENTS_CONCURRENCY = 20;

/** Campos de rastreio do job (o `meta` completo é validado pelo processor). */
function traceMetaOf(job: Job): JobTraceMeta {
  const meta: unknown = (job.data as { meta?: unknown } | undefined)?.meta;
  const record = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const traceparent = text(record.traceparent);
  const tracestate = text(record.tracestate);
  return {
    correlationId: text(record.correlationId) ?? job.id ?? 'unknown',
    tenantId: text(record.tenantId) ?? null,
    causationId: text(record.causationId) ?? null,
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

/**
 * Peças do outbox no worker (US-082 · DEC-052/072): o relay (`cf_relay` → `domain-events`) e o
 * consumidor de `domain-events` (`DomainEventsProcessor` → `notifications` + handlers leves).
 * Sobe no bootstrap do contexto Nest e encerra no shutdown gracioso. O wrapper completo de
 * consumo (`runJob`, DLQ, Bull Board, timeouts) é da US-083.
 */
@Injectable()
export class OutboxRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRuntime');
  private database: OutboxDatabase | undefined;
  private publisher: BullDomainEventsPublisher | undefined;
  private relay: OutboxRelay | undefined;
  private cache: TenantRedisCache | undefined;
  private fanOut: BullFanOutQueues | undefined;
  private worker: Worker | undefined;

  constructor(@Inject(OUTBOX_RUNTIME_CONFIG) private readonly config: OutboxRuntimeConfig) {}

  get relayInstance(): OutboxRelay | undefined {
    return this.relay;
  }

  onApplicationBootstrap(): void {
    const { appEnv, redisUrl, relayDatabaseUrl } = this.config;
    this.database = createOutboxDatabase({ url: relayDatabaseUrl });
    this.publisher = new BullDomainEventsPublisher({ redisUrl, appEnv });
    const relay = new OutboxRelay({ database: this.database, publisher: this.publisher });
    this.relay = relay;
    observeRelayLeader(() => relay.isLeader);
    relay.start();

    this.cache = new TenantRedisCache({ redisUrl, appEnv });
    this.cache.connect().catch(() => undefined);
    this.fanOut = new BullFanOutQueues({ redisUrl, appEnv });
    const processor = new DomainEventsProcessor({
      queues: this.fanOut,
      handlers: [
        new PermissionCacheInvalidator(this.cache),
        new BusinessMetricsCollector(this.cache),
      ],
    });
    this.worker = new Worker(
      DOMAIN_EVENTS_QUEUE,
      (job: Job) =>
        runInJobContext(
          {
            queue: DOMAIN_EVENTS_QUEUE,
            jobName: job.name,
            jobId: job.id ?? '',
            attempt: job.attemptsMade + 1,
          },
          traceMetaOf(job),
          () => processor.process(job.data, job.id),
        ),
      {
        connection: consumerConnection(redisUrl),
        prefix: queuePrefix(appEnv),
        concurrency: DOMAIN_EVENTS_CONCURRENCY,
        settings: { backoffStrategy },
      },
    );
    this.worker.on('error', (error) => {
      this.logger.warn({
        event: 'queue.worker_error',
        queue: DOMAIN_EVENTS_QUEUE,
        cause: error.name,
      });
    });
    this.worker.on('failed', (job, error) => {
      this.logger.warn({
        event: 'job.failed',
        queue: DOMAIN_EVENTS_QUEUE,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        cause: error.name,
      });
    });
    this.logger.log({ event: 'outbox.runtime_started' }, 'outbox relay and domain-events started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.relay?.stop();
    await this.publisher?.close();
    await this.fanOut?.close();
    this.cache?.close();
    await this.database?.close();
  }
}
