import type { DependencyCriticality, HealthCheck } from '@contrataflow/observability';
import { Redis } from 'ioredis';

/*
 * Redis no `/health/ready` do worker (US-085 · DEC-131 · observability.md §6.2): `PING` numa
 * conexão própria, sem fila offline — com o Redis fora o comando falha na hora. O Redis de filas é
 * CRÍTICO no worker (sem ele nenhum job anda).
 */
export function redisHealthCheck(options: {
  readonly name: string;
  readonly url: string;
  readonly criticality: DependencyCriticality;
  readonly timeoutMs: number;
}): { readonly check: HealthCheck; close(): void } {
  const redis = new Redis(options.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: options.timeoutMs,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  redis.on('error', () => undefined);
  redis.connect().catch(() => undefined);
  return {
    check: {
      name: options.name,
      measurement: 'responseTime',
      criticality: options.criticality,
      timeoutMs: options.timeoutMs,
      probe: async () => {
        await redis.ping();
        return undefined;
      },
    },
    close: () => {
      redis.disconnect();
    },
  };
}
