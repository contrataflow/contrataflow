import 'server-only';

import { Redis } from 'ioredis';

import { log } from '../logger';

/**
 * Cliente do Redis de sessões (DEC-131 · US-087): único ponto do web que fala com o Redis — chaves
 * de plataforma (`cf:{env}:sess:*`, `cf:{env}:rl:auth:*`), fora do `TenantCache` (allowlist da
 * regra `contrataflow/no-direct-redis`). Sem fila infinita nem espera longa: comando que não
 * responde em 1 s falha, e o BFF responde 503 (nunca "sessão expirada").
 */
export function createSessionRedis(url: string): Redis {
  const redis = new Redis(url, {
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  redis.on('error', (error: Error) => {
    log('warn', 'auth.session_store_unavailable', { errorName: error.name });
  });
  return redis;
}
