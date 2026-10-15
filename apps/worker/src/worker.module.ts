import type { Logger as PinoLogger } from '@contrataflow/observability';
import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import type { OutboxRuntimeConfig } from '#config/outbox.js';
import type { QueueRuntimeConfig } from '#config/queues.js';
import type { SessionsRuntimeConfig } from '#config/sessions.js';

import { TraceDemoJobHandler } from './jobs/trace-demo.job.js';
import {
  OUTBOX_RUNTIME_CONFIG,
  OutboxRuntime,
  SESSION_TERMINATION_CONFIG,
} from './outbox/outbox.runtime.js';
import { JobHandlerRegistry } from './queues/job-handler-registry.js';
import { QUEUE_RUNTIME_CONFIG, QueueRuntime } from './queues/queue.runtime.js';

export interface WorkerModuleOptions {
  /** Relay do outbox e consumidor de `domain-events` (US-082); `null` = desligados. */
  readonly outbox?: OutboxRuntimeConfig | null;
  /** Redis de sessões do encerramento por vínculo (US-088); `null` = descarta com aviso. */
  readonly sessions?: SessionsRuntimeConfig | null;
  /**
   * Filas, schedulers e Bull Board (US-083). Sem ele, mas com o outbox, as filas sobem só com o
   * Redis do outbox (sem banco: sem schedulers nem painel); sem os dois, desligadas.
   */
  readonly queues?: QueueRuntimeConfig | null;
}

/** Configuração efetiva das filas: a explícita ou a mínima derivada do outbox. */
function queuesConfigOf(options: WorkerModuleOptions): QueueRuntimeConfig | null {
  if (options.queues) return options.queues;
  if (!options.outbox) return null;
  return {
    appEnv: options.outbox.appEnv,
    redisUrl: options.outbox.redisUrl,
    workerDatabaseUrl: null,
    admin: null,
  };
}

/**
 * Composition root do worker (DEC-052): importa as camadas application/infrastructure dos
 * módulos da API e registra processors, schedulers e o relay do outbox (stories donas). O logger
 * pino (US-084) substitui o do Nest; sem HTTP, o `nestjs-pino` não registra middleware.
 */
@Module({})
export class WorkerModule {
  static forRoot(logger: PinoLogger, options: WorkerModuleOptions = {}): DynamicModule {
    const outbox: Provider[] = options.outbox
      ? [
          { provide: OUTBOX_RUNTIME_CONFIG, useValue: options.outbox },
          { provide: SESSION_TERMINATION_CONFIG, useValue: options.sessions ?? null },
          OutboxRuntime,
        ]
      : [];
    const queuesConfig = queuesConfigOf(options);
    const queues: Provider[] = queuesConfig
      ? [{ provide: QUEUE_RUNTIME_CONFIG, useValue: queuesConfig }, QueueRuntime]
      : [];
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { logger } })],
      providers: [TraceDemoJobHandler, JobHandlerRegistry, ...outbox, ...queues],
    };
  }
}
