import { Module } from '@nestjs/common';

/**
 * Composition root do worker (DEC-052): importa as camadas application/infrastructure dos
 * módulos da API e registra processors, schedulers e o relay do outbox (stories donas).
 */
@Module({})
export class WorkerModule {}
