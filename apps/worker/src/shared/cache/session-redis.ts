import { sessionKeyspace } from '@contrataflow/types';
import type { SessionKeyspace } from '@contrataflow/types';
import { endSession, parseSessionHeader } from '@contrataflow/validation';
import type { EndSessionInput, SessionEndRedis, SessionHeader } from '@contrataflow/validation';
import { Redis } from 'ioredis';

/*
 * Redis de sessões do worker (US-088 · RN-IAM-27 · authentication.md §4/§7): conexão própria — o
 * Redis de sessões é outro serviço (crítico, HA — DEC-131), separado do Redis das filas e do cache.
 * Junto com `tenant-redis.ts`, é o único ponto do worker com cliente Redis (RM-03 — lint
 * `contrataflow/no-direct-redis`). As chaves são de plataforma (`cf:{env}:sess:*`), montadas pelo
 * protocolo compartilhado `sessionKeyspace`; o worker só lê o cabeçalho do registro vivo (nunca os
 * tokens cifrados) e encerra pelo mesmo `endSession` do BFF e da varredura, que deixa o registro de
 * encerramento para a api auditar — o worker não grava auditoria.
 */

export interface SessionRedisOptions {
  readonly redisUrl: string;
  readonly appEnv: string;
}

/** Subconjunto de comandos usados aqui (ioredis em produção; em memória nos testes). */
export interface SessionRedisClient extends SessionEndRedis {
  get(key: string): Promise<string | null>;
  smembers(key: string): Promise<string[]>;
}

export class SessionRedis {
  private readonly keys: SessionKeyspace;
  private readonly redis: SessionRedisClient;
  /** Conexão criada aqui (e fechada aqui); ausente quando o cliente vem de fora (testes). */
  private readonly owned: Redis | undefined;

  constructor(options: SessionRedisOptions, client?: SessionRedisClient) {
    this.keys = sessionKeyspace(options.appEnv);
    if (client) {
      this.redis = client;
      return;
    }
    const redis = new Redis(options.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // Queda do Redis: os comandos falham e o job do `domain-events` é repetido pela fila.
    redis.on('error', () => undefined);
    this.owned = redis;
    this.redis = redis;
  }

  async connect(): Promise<void> {
    if (this.owned?.status === 'wait') await this.owned.connect();
  }

  /** Chaves das sessões cujo vínculo ativo é `membershipId` (índice mantido pelo BFF). */
  membersOf(membershipId: string): Promise<string[]> {
    return this.redis.smembers(this.keys.membership(membershipId));
  }

  /** Cabeçalho do registro vivo; `null` se a sessão não existe mais ou o registro é ilegível. */
  async readHeader(sessionKey: string): Promise<SessionHeader | null> {
    return parseSessionHeader(await this.redis.get(this.keys.record(sessionKey)));
  }

  /** Remove do índice do vínculo uma entrada órfã ou velha (sem encerrar nenhuma sessão). */
  async forget(membershipId: string, sessionKey: string): Promise<void> {
    await this.redis.srem(this.keys.membership(membershipId), sessionKey);
  }

  /** `true` só para quem de fato encerrou a sessão (concorrentes e reentregas recebem `false`). */
  end(input: EndSessionInput): Promise<boolean> {
    return endSession(this.redis, this.keys, input);
  }

  close(): void {
    this.owned?.disconnect();
  }
}
