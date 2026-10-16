import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import type { OutboxRuntimeConfig } from '#config/outbox.js';
import type { SessionsRuntimeConfig } from '#config/sessions.js';
import { SessionRedis } from '#shared/cache/session-redis.js';
import { TenantRedisCache } from '#shared/cache/tenant-redis.js';
import { createOutboxDatabase } from '#shared/database/outbox-database.js';
import type { OutboxDatabase } from '#shared/database/outbox-database.js';

import { BullDomainEventsPublisher } from './domain-events.publisher.js';
import { OutboxRelay } from './outbox-relay.js';
import { observeRelayLeader } from './outbox-telemetry.js';
import { BullFanOutQueues } from '../events/bull-fan-out.queues.js';
import { DomainEventsJobHandler } from '../events/domain-events.job.js';
import { DomainEventsProcessor } from '../events/domain-events.processor.js';
import {
  BusinessMetricsCollector,
  ConfigCacheInvalidator,
  InvitationEmailEnqueuer,
  PermissionCacheInvalidator,
} from '../events/inline-handlers.js';
import type { InlineEventHandler } from '../events/inline-handlers.js';
import {
  SessionTerminationDisabled,
  SessionTerminationHandler,
} from '../events/session-termination.handler.js';
import { JobHandlerRegistry } from '../queues/job-handler-registry.js';
import { QueueRuntime } from '../queues/queue.runtime.js';

export const OUTBOX_RUNTIME_CONFIG = Symbol('OutboxRuntimeConfig');
/** Redis de sessões do encerramento por vínculo (US-088); `null` = consumidor desligado. */
export const SESSION_TERMINATION_CONFIG = Symbol('SessionTerminationConfig');

/**
 * Peças do outbox no worker (US-082 · DEC-052/072): o relay (`cf_relay` → `domain-events`) e o
 * consumidor de `domain-events` (`DomainEventsProcessor` → `notifications` + handlers leves,
 * entre eles o encerramento de sessões por mudança de vínculo — US-088).
 * O consumidor de `domain-events` é registrado como handler no `JobHandlerRegistry` e roda no
 * `Worker` do `QueueRuntime`, pelo `runJob` (US-083: contrato comum, timeouts, dead-letter).
 * Sobe no bootstrap do contexto Nest e encerra no shutdown gracioso.
 */
@Injectable()
export class OutboxRuntime implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRuntime');
  private database: OutboxDatabase | undefined;
  private publisher: BullDomainEventsPublisher | undefined;
  private relay: OutboxRelay | undefined;
  private cache: TenantRedisCache | undefined;
  private sessions: SessionRedis | undefined;
  private fanOut: BullFanOutQueues | undefined;

  constructor(
    @Inject(OUTBOX_RUNTIME_CONFIG) private readonly config: OutboxRuntimeConfig,
    @Inject(SESSION_TERMINATION_CONFIG)
    private readonly sessionsConfig: SessionsRuntimeConfig | null,
    private readonly registry: JobHandlerRegistry,
    private readonly queueRuntime: QueueRuntime,
  ) {}

  get relayInstance(): OutboxRelay | undefined {
    return this.relay;
  }

  /** Registra o consumidor de `domain-events` antes de o `QueueRuntime` subir os `Worker`s. */
  onModuleInit(): void {
    const { appEnv, redisUrl } = this.config;
    this.cache = new TenantRedisCache({ redisUrl, appEnv });
    this.cache.connect().catch(() => undefined);
    this.fanOut = new BullFanOutQueues({ redisUrl, appEnv });
    const processor = new DomainEventsProcessor({
      queues: this.fanOut,
      handlers: [
        new PermissionCacheInvalidator(this.cache),
        new BusinessMetricsCollector(this.cache),
        new ConfigCacheInvalidator(this.cache),
        // US-091: o produtor do `QueueRuntime` nasce no `onModuleInit` dele; só é lido ao tratar um
        // evento, já com as filas no ar.
        new InvitationEmailEnqueuer({
          enqueue: (queue, name, payload, options) =>
            this.queueRuntime.producer.enqueue(queue, name, payload, options),
        }),
        this.createSessionTermination(),
      ],
    });
    this.registry.register(new DomainEventsJobHandler(processor));
  }

  onApplicationBootstrap(): void {
    const { appEnv, redisUrl, relayDatabaseUrl } = this.config;
    this.database = createOutboxDatabase({ url: relayDatabaseUrl });
    this.publisher = new BullDomainEventsPublisher({ redisUrl, appEnv });
    const relay = new OutboxRelay({ database: this.database, publisher: this.publisher });
    this.relay = relay;
    observeRelayLeader(() => relay.isLeader);
    relay.start();
    this.logger.log({ event: 'outbox.runtime_started' }, 'outbox relay started');
  }

  /**
   * Encerramento de sessões por vínculo (RN-IAM-27): com o Redis de sessões configurado, o handler
   * real (conexão própria, sem derrubar a subida se o Redis estiver fora — os comandos falham e o
   * job é repetido); sem ele, um handler que descarta o evento com aviso, porque a rota casa e o
   * `DomainEventsProcessor` falha para handler não registrado.
   */
  private createSessionTermination(): InlineEventHandler {
    if (this.sessionsConfig === null) return new SessionTerminationDisabled();
    this.sessions = new SessionRedis(this.sessionsConfig);
    this.sessions.connect().catch(() => undefined);
    return new SessionTerminationHandler(this.sessions);
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay?.stop();
    await this.publisher?.close();
    await this.fanOut?.close();
    this.cache?.close();
    this.sessions?.close();
    await this.database?.close();
  }
}
