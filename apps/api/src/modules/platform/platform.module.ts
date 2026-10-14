import { Module } from '@nestjs/common';

import { IDEMPOTENCY_STORE } from '#shared/idempotency/idempotency.js';
import { RATE_LIMIT_STORE } from '#shared/rate-limit/rate-limit.js';

import { PlatformFacade } from './application/platform.facade.js';
import { RedisIdempotencyStore } from './infrastructure/redis/redis-idempotency.store.js';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage.js';
import { RedisClient } from './infrastructure/redis/redis.client.js';
import { InternalExampleController } from './presentation/internal-example.controller.js';

/**
 * Módulo `platform` (DEC-040, nível 0): outros módulos usam somente a fachada exportada. Fornece
 * os armazenamentos Redis do rate limit e da idempotência ao pipeline HTTP e a rota interna de
 * exemplo da US-080.
 */
@Module({
  controllers: [InternalExampleController],
  providers: [
    PlatformFacade,
    RedisClient,
    { provide: RATE_LIMIT_STORE, useClass: RedisThrottlerStorage },
    { provide: IDEMPOTENCY_STORE, useClass: RedisIdempotencyStore },
  ],
  exports: [PlatformFacade, RATE_LIMIT_STORE, IDEMPOTENCY_STORE],
})
export class PlatformModule {}
