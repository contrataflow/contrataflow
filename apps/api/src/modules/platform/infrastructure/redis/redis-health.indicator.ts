import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { HealthRegistry } from '#shared/observability/health.module.js';

import { RedisClient } from './redis.client.js';

/**
 * *Health indicator* do Redis de filas, idempotência e cache (US-085 · observability.md §6.2):
 * `PING` com timeout de 500 ms, DEGRADÁVEL na api — com ele fora a API conclui a ação e o trabalho
 * assíncrono fica pendente (CA-T-07); a readiness responde `warn`, nunca `fail`.
 */
@Injectable()
export class RedisHealthIndicator implements OnModuleInit {
  constructor(
    private readonly client: RedisClient,
    private readonly health: HealthRegistry,
  ) {}

  onModuleInit(): void {
    this.health.register({
      name: 'redis-cache',
      measurement: 'responseTime',
      criticality: 'degradable',
      timeoutMs: this.health.timeoutFor('redis'),
      probe: async () => {
        await this.client.redis.ping();
        return undefined;
      },
    });
  }
}
