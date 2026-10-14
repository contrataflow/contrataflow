import type { Logger as PinoLogger } from '@contrataflow/observability';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { TraceDemoJobHandler } from './jobs/trace-demo.job.js';

/**
 * Composition root do worker (DEC-052): importa as camadas application/infrastructure dos
 * módulos da API e registra processors, schedulers e o relay do outbox (stories donas). O logger
 * pino (US-084) substitui o do Nest; sem HTTP, o `nestjs-pino` não registra middleware.
 */
@Module({})
export class WorkerModule {
  static forRoot(logger: PinoLogger): DynamicModule {
    return {
      module: WorkerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: { logger } })],
      providers: [TraceDemoJobHandler],
    };
  }
}
