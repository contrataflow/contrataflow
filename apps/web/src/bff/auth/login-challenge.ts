import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { seal, unseal } from '../crypto';
import type { PendingLogin } from './password-login';
import { SessionStoreUnavailableError } from '../session/types';

/*
 * Transação de MFA do login nativo (DEC-187): entre a senha aceita e o código, o estado do *flow*
 * no IdP fica no Redis de sessões, cifrado (AES-256-GCM, AAD = chave), por 5 min e no máximo 5
 * códigos errados. O navegador guarda só um id opaco de 256 bits; a chave do Redis é o SHA-256
 * dele. Leitura e remoção são atômicas (`GETDEL`): duas submissões do mesmo código não concluem
 * duas vezes.
 */

export const LOGIN_CHALLENGE_TTL_MS = 5 * 60_000;
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;

export interface LoginChallenge {
  readonly pending: PendingLogin;
  /** Destino já validado (`safeReturnTo`) no início do login. */
  readonly returnTo: string;
  /** HMAC do usuário (limite por usuário e logs — nunca o nome). */
  readonly userKey: string;
  /** Códigos recusados até aqui. */
  readonly attempts: number;
  /** Epoch em ms; o prazo não se renova a cada código errado. */
  readonly expiresAt: number;
}

/** Armazenamento bruto (valor já cifrado). */
export interface LoginChallengeBackend {
  put(key: string, value: string, expiresAt: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

/** Subconjunto do ioredis usado aqui. */
export interface LoginChallengeRedis {
  set(key: string, value: string, mode: 'PXAT', expiresAt: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export class RedisLoginChallengeBackend implements LoginChallengeBackend {
  constructor(private readonly redis: LoginChallengeRedis) {}

  async put(key: string, value: string, expiresAt: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'PXAT', expiresAt);
    } catch (error) {
      throw new SessionStoreUnavailableError({ cause: error });
    }
  }

  async take(key: string): Promise<string | null> {
    try {
      return await this.redis.getdel(key);
    } catch (error) {
      throw new SessionStoreUnavailableError({ cause: error });
    }
  }
}

/** Em memória do processo (local/dev/test sem Redis de sessões). */
export class MemoryLoginChallengeBackend implements LoginChallengeBackend {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  put(key: string, value: string, expiresAt: number): Promise<void> {
    if (this.entries.size > 10_000) this.entries.clear();
    this.entries.set(key, { value, expiresAt });
    return Promise.resolve();
  }

  take(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return Promise.resolve(entry && entry.expiresAt > this.now() ? entry.value : null);
  }
}

/** Id opaco devolvido ao navegador (base64url, 256 bits). */
const TRANSACTION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isLoginChallengeId(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_PATTERN.test(value);
}

export class LoginChallengeStore {
  constructor(
    private readonly backend: LoginChallengeBackend,
    private readonly options: {
      readonly key: Buffer;
      /** `cf:{env}:login-mfa:`. */
      readonly keyPrefix: string;
      readonly now: () => number;
    },
  ) {}

  /** Abre uma transação nova e devolve o id para o navegador. */
  async open(pending: PendingLogin, returnTo: string, userKey: string): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    await this.save(id, {
      pending,
      returnTo,
      userKey,
      attempts: 0,
      expiresAt: this.options.now() + LOGIN_CHALLENGE_TTL_MS,
    });
    return id;
  }

  /** Retira a transação (uso único); `null` se não existe, expirou ou foi adulterada. */
  async take(id: string): Promise<LoginChallenge | null> {
    const key = this.redisKey(id);
    const sealed = await this.backend.take(key);
    if (!sealed) return null;
    const plain = unseal(this.options.key, sealed, key);
    if (!plain) return null;
    const challenge = JSON.parse(plain) as LoginChallenge;
    return challenge.expiresAt > this.options.now() ? challenge : null;
  }

  /** Devolve a transação (código errado, IdP fora) mantendo o prazo original. */
  async save(id: string, challenge: LoginChallenge): Promise<void> {
    if (challenge.expiresAt <= this.options.now()) return;
    const key = this.redisKey(id);
    await this.backend.put(
      key,
      seal(this.options.key, JSON.stringify(challenge), key),
      challenge.expiresAt,
    );
  }

  private redisKey(id: string): string {
    return `${this.options.keyPrefix}${createHash('sha256').update(id).digest('hex')}`;
  }
}
