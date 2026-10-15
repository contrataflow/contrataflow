import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { AUDIT_SAMPLING_STORE } from '#shared/audit/sampling-store.js';
import { IDEMPOTENCY_STORE } from '#shared/idempotency/idempotency.js';
import { OUTBOX_WRITER, SYNC_EVENT_HANDLERS } from '#shared/outbox/outbox-writer.js';
import { RATE_LIMIT_STORE } from '#shared/rate-limit/rate-limit.js';

import { OUTBOX_STORE } from './application/outbox-ports.js';
import { OutboxWriterService } from './application/outbox-writer.service.js';
import { PlatformFacade } from './application/platform.facade.js';
import { SyncEventHandlerRegistry } from './application/sync-event-handler.registry.js';
import { InMemoryOutboxStore } from './infrastructure/outbox/in-memory-outbox.store.js';
import { PrismaOutboxStore } from './infrastructure/outbox/prisma-outbox.store.js';
import { RedisAuditSamplingStore } from './infrastructure/redis/redis-audit-sampling.store.js';
import { RedisIdempotencyStore } from './infrastructure/redis/redis-idempotency.store.js';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage.js';
import { RedisClient } from './infrastructure/redis/redis.client.js';
import { InternalExampleController } from './presentation/internal-example.controller.js';

/**
 * Módulo `platform` (DEC-040, nível 0): outros módulos usam somente a fachada exportada. Fornece
 * os armazenamentos Redis do rate limit e da idempotência ao pipeline HTTP, os contadores da
 * amostragem de `access.denied` à auditoria (US-073), a rota interna de exemplo da US-080 e o
 * outbox transacional (US-082). É GLOBAL porque todo módulo que produz fato de domínio injeta a
 * porta `OUTBOX_WRITER` (e os donos das projeções síncronas, `SYNC_EVENT_HANDLERS`) do shared
 * kernel, sem importar este módulo (DEC-072).
 */
@Global()
@Module({
  controllers: [InternalExampleController],
  providers: [
    PlatformFacade,
    RedisClient,
    { provide: RATE_LIMIT_STORE, useClass: RedisThrottlerStorage },
    { provide: IDEMPOTENCY_STORE, useClass: RedisIdempotencyStore },
    { provide: AUDIT_SAMPLING_STORE, useClass: RedisAuditSamplingStore },
    PrismaOutboxStore,
    {
      provide: OUTBOX_STORE,
      inject: [APP_CONFIG, PrismaOutboxStore],
      // Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): outbox em memória.
      useFactory: (config: AppConfig, prisma: PrismaOutboxStore) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryOutboxStore(),
    },
    SyncEventHandlerRegistry,
    { provide: SYNC_EVENT_HANDLERS, useExisting: SyncEventHandlerRegistry },
    OutboxWriterService,
    { provide: OUTBOX_WRITER, useExisting: OutboxWriterService },
  ],
  exports: [
    PlatformFacade,
    RATE_LIMIT_STORE,
    IDEMPOTENCY_STORE,
    AUDIT_SAMPLING_STORE,
    OUTBOX_WRITER,
    SYNC_EVENT_HANDLERS,
  ],
})
export class PlatformModule {}
