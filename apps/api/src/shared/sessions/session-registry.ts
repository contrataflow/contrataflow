import type { EndSessionInput, SessionHeader, SessionTombstone } from '@contrataflow/validation';

/*
 * Redis de sessões do BFF visto pela API (US-088 · RN-IAM-28 · DEC-131): só o que a varredura de
 * encerramentos precisa. O BFF é o dono do registro vivo (tokens cifrados) e quem encerra a sessão
 * no ato (logout, renovação recusada); a API audita o que ficou para trás (`auth.session_end`,
 * `auth.session_expired`) com o horário real do fato e só então apaga o registro de encerramento.
 *
 * O cliente Redis fica em `modules/platform` (único lugar com ioredis — RM-03); em memória nos
 * testes (`in-memory-session-registry.ts`) e desligado quando `REDIS_SESSION_URL` não foi
 * informada (só local/dev/test). O layout das chaves e as regras de encerramento vêm do protocolo
 * compartilhado de `@contrataflow/types` e `@contrataflow/validation` — esta porta não as repete.
 *
 * Nenhum método devolve ou registra tokens: o registro vivo é lido apenas como cabeçalho
 * (`SessionHeader`), sem `sealedTokens`.
 */
export interface SessionRegistryPort {
  /** `false` quando não há Redis de sessões configurado: a varredura não roda. */
  readonly enabled: boolean;
  /**
   * Trava da varredura (`SET NX PX`): só uma réplica por ciclo. Não é liberada — expira sozinha
   * antes do ciclo seguinte.
   */
  acquireSweepLock(ttlMs: number): Promise<boolean>;
  /** Chaves de sessão com prazo vencido em `now` (epoch ms), as mais antigas primeiro. */
  due(now: number, limit: number): Promise<string[]>;
  /** Registro de encerramento (sem tokens) ainda não auditado; `null` se não existe ou ilegível. */
  readTombstone(key: string): Promise<SessionTombstone | null>;
  /** Cabeçalho do registro vivo; `null` se não existe ou ilegível. */
  readLive(key: string): Promise<SessionHeader | null>;
  /**
   * Encerra a sessão vencida como o BFF faria (`endSession`): troca o registro vivo pelo de
   * encerramento. `false` = outro encerramento chegou antes (a auditoria é única).
   */
  end(input: EndSessionInput): Promise<boolean>;
  /** Novo prazo de uma sessão viva que foi acessada depois de o prazo antigo ser agendado. */
  reschedule(key: string, deadline: number): Promise<void>;
  /** Apaga o registro de encerramento e tira a chave do conjunto de prazos (pós-commit). */
  forget(key: string): Promise<void>;
}

export const SESSION_REGISTRY = Symbol('SessionRegistryPort');

/** Sem Redis de sessões (local/dev/test sem `REDIS_SESSION_URL`): a varredura fica desligada. */
export class DisabledSessionRegistry implements SessionRegistryPort {
  readonly enabled = false;

  acquireSweepLock(): Promise<boolean> {
    return Promise.resolve(false);
  }

  due(): Promise<string[]> {
    return Promise.resolve([]);
  }

  readTombstone(): Promise<SessionTombstone | null> {
    return Promise.resolve(null);
  }

  readLive(): Promise<SessionHeader | null> {
    return Promise.resolve(null);
  }

  end(): Promise<boolean> {
    return Promise.resolve(false);
  }

  reschedule(): Promise<void> {
    return Promise.resolve();
  }

  forget(): Promise<void> {
    return Promise.resolve();
  }
}
