import { randomUUID } from 'node:crypto';

import { sessionKeyspace } from '@contrataflow/types';
import type { SessionKeyspace } from '@contrataflow/types';
import { endSession, parseSessionHeader, parseSessionTombstone } from '@contrataflow/validation';
import type { EndSessionInput, SessionHeader, SessionTombstone } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { SessionRegistryPort } from '#shared/sessions/session-registry.js';

/** Intervalo mínimo entre logs de falha de conexão (evita inundar o log durante a queda). */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Redis de sessões do BFF (DEC-131) lido pela varredura de encerramentos (US-088 · RN-IAM-28).
 * Conexão PRÓPRIA, com `REDIS_SESSION_URL` — o Redis de sessões é um cluster à parte do principal
 * (crítico, `noeviction`, só o BFF e esta varredura o acessam). Mesmo perfil de falha do
 * `RedisClient`: sem fila offline e com timeout curto, para o ciclo da varredura falhar na hora
 * com o Redis fora (o comando que o chama registra `auth.session_sweep_failed` e tenta no ciclo
 * seguinte). As chaves vêm de `sessionKeyspace(appEnv)` — o mesmo layout do BFF.
 *
 * Só lê o cabeçalho do registro vivo: `parseSessionHeader` descarta `sealedTokens`, então tokens
 * nunca saem deste adaptador, nem em log.
 */
export class RedisSessionRegistry
  implements SessionRegistryPort, OnApplicationBootstrap, OnModuleDestroy
{
  readonly enabled = true;
  private readonly redis: Redis;
  private readonly keys: SessionKeyspace;
  private readonly logger = new Logger('SessionRegistry');
  private lastErrorLogAt = 0;

  constructor(sessionUrl: string, appEnv: string) {
    this.keys = sessionKeyspace(appEnv);
    this.redis = new Redis(sessionUrl, {
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
      this.logger.warn(`redis.session_connection_error cause=${error.name}`);
    });
  }

  onApplicationBootstrap(): void {
    this.redis.connect().catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async acquireSweepLock(ttlMs: number): Promise<boolean> {
    const acquired = await this.redis.set(this.keys.sweepLock, randomUUID(), 'PX', ttlMs, 'NX');
    return acquired === 'OK';
  }

  due(now: number, limit: number): Promise<string[]> {
    return this.redis.zrangebyscore(this.keys.expiry, '-inf', now, 'LIMIT', 0, limit);
  }

  async readTombstone(key: string): Promise<SessionTombstone | null> {
    return parseSessionTombstone(await this.redis.get(this.keys.ended(key)));
  }

  async readLive(key: string): Promise<SessionHeader | null> {
    return parseSessionHeader(await this.redis.get(this.keys.record(key)));
  }

  end(input: EndSessionInput): Promise<boolean> {
    return endSession(this.redis, this.keys, input);
  }

  async reschedule(key: string, deadline: number): Promise<void> {
    await this.redis.zadd(this.keys.expiry, deadline, key);
  }

  async forget(key: string): Promise<void> {
    await this.redis.del(this.keys.ended(key));
    await this.redis.zrem(this.keys.expiry, key);
  }
}
