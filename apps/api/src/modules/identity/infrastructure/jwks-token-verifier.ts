import { Logger } from '@nestjs/common';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWTPayload } from 'jose';

import { TokenVerificationError, TokenVerifierUnavailableError } from '#shared/auth/ports.js';
import type { TokenVerifierPort, VerifiedToken } from '#shared/auth/ports.js';

/** Algoritmos aceitos (RN-IAM-04/05): `none`, HMAC e qualquer outro são recusados. */
export const ALLOWED_ALGORITHMS: readonly string[] = ['RS256', 'ES256'];

export interface JwksTokenVerifierOptions {
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly clockToleranceSeconds: number;
  /** URL do JWKS; padrão: `jwks_uri` da descoberta OIDC do emissor. */
  readonly jwksUri?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Validade do cache de chaves (RN-IAM-05: 10 min). */
  readonly cacheTtlMs?: number;
  /** Intervalo mínimo entre renovações (RN-IAM-05: 1×/30 s — proteção contra `kid` aleatório). */
  readonly refreshCooldownMs?: number;
  readonly timeoutMs?: number;
}

interface CachedKeys {
  readonly kids: ReadonlySet<string>;
  readonly fetchedAt: number;
  readonly keySet: ReturnType<typeof createLocalJWKSet>;
}

type RefreshReason = 'initial' | 'expired' | 'unknown_kid';

function isJwks(value: unknown): value is JSONWebKeySet {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { keys?: unknown }).keys) &&
    (value as { keys: unknown[] }).keys.every((key) => typeof key === 'object' && key !== null)
  );
}

function toVerifiedToken(payload: JWTPayload): VerifiedToken {
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new TokenVerificationError('INVALID');
  }
  const amr = Array.isArray(payload.amr) ? payload.amr : [];
  return {
    subject: payload.sub,
    amr: amr.filter((value): value is string => typeof value === 'string'),
    authTime: typeof payload.auth_time === 'number' ? new Date(payload.auth_time * 1000) : null,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true,
  };
}

/**
 * Verificador do access token emitido pelo Authentik (RN-IAM-05 · DEC-132): assinatura pelo JWKS
 * em cache (10 min, renovação forçada ao ver `kid` desconhecido, no máximo 1 vez a cada 30 s),
 * `iss`, `aud` da API, `exp`, `nbf`, algoritmo permitido e tolerância ≤ 60 s. Com o JWKS fora do
 * ar, tokens de chave já conhecida continuam aceitos; `kid` desconhecido → indisponibilidade (503).
 */
export class JwksTokenVerifier implements TokenVerifierPort {
  private readonly logger = new Logger('Auth');
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly refreshCooldownMs: number;
  private readonly timeoutMs: number;
  private cached: CachedKeys | null = null;
  private jwksUri: string | null;
  /** Última busca de qualquer tipo (inicial, vencimento, `kid` desconhecido). */
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** Última renovação forçada por `kid` desconhecido (limite de 1×/30 s — RN-IAM-05). */
  private lastForcedAt = Number.NEGATIVE_INFINITY;
  private lastAttemptFailed = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: JwksTokenVerifierOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 600_000;
    this.refreshCooldownMs = options.refreshCooldownMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.jwksUri = options.jwksUri ?? null;
  }

  async verify(token: string): Promise<VerifiedToken> {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new TokenVerificationError('INVALID');
    }
    if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.includes(header.alg)) {
      throw new TokenVerificationError('INVALID');
    }
    const kid = typeof header.kid === 'string' ? header.kid : null;
    await this.ensureKeys(kid);

    const cached = this.cached;
    if (!cached) throw new TokenVerifierUnavailableError();
    if (kid !== null && !cached.kids.has(kid)) {
      // Desconhecido mesmo depois de tentar renovar: com o JWKS fora do ar não há como decidir.
      if (this.lastAttemptFailed) throw new TokenVerifierUnavailableError();
      throw new TokenVerificationError('INVALID');
    }

    try {
      const { payload } = await jwtVerify(token, cached.keySet, {
        issuer: this.options.issuer,
        audience: [...this.options.audiences],
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: this.options.clockToleranceSeconds,
        currentDate: new Date(this.now()),
      });
      return toVerifiedToken(payload);
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new TokenVerificationError('EXPIRED');
      if (error instanceof TokenVerificationError) throw error;
      throw new TokenVerificationError('INVALID');
    }
  }

  private async ensureKeys(kid: string | null): Promise<void> {
    const cached = this.cached;
    const stale = !cached || this.now() - cached.fetchedAt >= this.cacheTtlMs;
    const unknownKid = kid !== null && cached !== null && !cached.kids.has(kid);
    if (!stale && !unknownKid) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const reason: RefreshReason = !cached ? 'initial' : unknownKid ? 'unknown_kid' : 'expired';
    // `kid` desconhecido: 1 renovação forçada a cada 30 s; demais buscas: espera 30 s após uma
    // tentativa (IdP fora do ar não é consultado a cada requisição).
    const since = reason === 'unknown_kid' ? this.lastForcedAt : this.lastAttemptAt;
    if (this.now() - since < this.refreshCooldownMs) return;
    if (reason === 'unknown_kid') this.lastForcedAt = this.now();
    this.inflight = this.refresh(reason).finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async refresh(reason: RefreshReason): Promise<void> {
    this.lastAttemptAt = this.now();
    try {
      const uri = this.jwksUri ?? (await this.discoverJwksUri());
      this.jwksUri = uri;
      const jwks = await this.getJson(uri);
      if (!isJwks(jwks)) throw new Error('JWKS inválido');
      const kids = jwks.keys
        .map((key) => key.kid)
        .filter((value): value is string => typeof value === 'string');
      this.cached = { kids: new Set(kids), fetchedAt: this.now(), keySet: createLocalJWKSet(jwks) };
      this.lastAttemptFailed = false;
      if (reason === 'unknown_kid') {
        this.logger.warn(
          { event: 'auth.jwks_refresh', reason, result: 'success', keys: kids.length },
          'auth.jwks_refresh',
        );
      }
    } catch (error) {
      this.lastAttemptFailed = true;
      // Alerta: sem chaves novas, tokens assinados por chave rotacionada são recusados (503).
      this.logger.error(
        {
          event: 'auth.jwks_refresh',
          reason,
          result: 'failure',
          alert: true,
          errorName: error instanceof Error ? error.name : 'unknown',
          cachedKeys: this.cached?.kids.size ?? 0,
        },
        'auth.jwks_refresh',
      );
    }
  }

  private async discoverJwksUri(): Promise<string> {
    const base = this.options.issuer.endsWith('/')
      ? this.options.issuer
      : `${this.options.issuer}/`;
    const discovery = await this.getJson(new URL('.well-known/openid-configuration', base).href);
    const document = discovery as { issuer?: unknown; jwks_uri?: unknown };
    if (document.issuer !== this.options.issuer || typeof document.jwks_uri !== 'string') {
      throw new Error('Documento de descoberta OIDC inválido');
    }
    return document.jwks_uri;
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}
