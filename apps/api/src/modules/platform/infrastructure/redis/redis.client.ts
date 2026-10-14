import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

/** Intervalo mínimo entre logs de falha de conexão (evita inundar o log durante a queda). */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Cliente do Redis principal (DEC-131) para rate limit e idempotência. Sem fila offline e com
 * timeout curto: com o Redis fora, os comandos falham na hora e os chamadores degradam (CA-T-07)
 * em vez de segurar a requisição. Reconecta sozinho em segundo plano.
 */
@Injectable()
export class RedisClient implements OnApplicationBootstrap, OnModuleDestroy {
  readonly redis: Redis;
  private readonly logger = new Logger('Redis');
  private lastErrorLogAt = 0;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.redis = new Redis(config.redis.cacheUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    this.redis.on('error', (error: Error) => {
      const now = Date.now();
      if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
      this.lastErrorLogAt = now;
      this.logger.warn(`redis.connection_error cause=${error.name}`);
    });
  }

  onApplicationBootstrap(): void {
    this.redis.connect().catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
