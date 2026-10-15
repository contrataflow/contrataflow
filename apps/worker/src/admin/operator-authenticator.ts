import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { WorkerDatabase } from '#shared/database/worker-database.js';

/*
 * Acesso de operador de plataforma ao Bull Board e à CLI (RN-FND-69 · permissions.md §8 ·
 * queues.md §15.1): access token do cliente OIDC de operação validado pelo JWKS do emissor;
 * `PLATFORM_QUEUE_ADMIN` pela claim `cf_platform_permissions`; `isPlatformOperator` relido em
 * `users`; MFA pelo `amr` (RFC 8176). A ordem dos erros segue a story: sem token → 401; sem
 * permissão → 403 `PERMISSION_DENIED`; sem MFA → 403 `MFA_REQUIRED`.
 */

export const PLATFORM_QUEUE_ADMIN = 'PLATFORM_QUEUE_ADMIN';

/** Valores de `amr` que comprovam segundo fator (RFC 8176 — os mesmos da API). */
export const MFA_AMR_VALUES: readonly string[] = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face'];

export type OperatorAccessCode = 'UNAUTHENTICATED' | 'PERMISSION_DENIED' | 'MFA_REQUIRED';

export class OperatorAccessError extends Error {
  constructor(
    readonly code: OperatorAccessCode,
    /** Usuário identificado (para a auditoria da negação), quando houver. */
    readonly operator: OperatorIdentity | null = null,
  ) {
    super(code);
    this.name = 'OperatorAccessError';
  }
}

export interface VerifiedOperatorToken {
  readonly subject: string;
  readonly amr: readonly string[];
  readonly permissions: readonly string[];
}

export interface OperatorTokenVerifier {
  /** Lança qualquer erro para token inválido/expirado. */
  verify(token: string): Promise<VerifiedOperatorToken>;
}

export interface OperatorRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly isPlatformOperator: boolean;
}

export interface OperatorDirectory {
  findBySubject(subject: string): Promise<OperatorRecord | null>;
}

export interface OperatorIdentity {
  readonly userId: string;
  readonly name: string;
}

export class OperatorAuthenticator {
  constructor(
    private readonly verifier: OperatorTokenVerifier,
    private readonly directory: OperatorDirectory,
  ) {}

  async authenticate(token: string | null): Promise<OperatorIdentity> {
    if (!token) throw new OperatorAccessError('UNAUTHENTICATED');
    let verified: VerifiedOperatorToken;
    try {
      verified = await this.verifier.verify(token);
    } catch {
      throw new OperatorAccessError('UNAUTHENTICATED');
    }
    const user = await this.directory.findBySubject(verified.subject);
    const identity = user ? { userId: user.id, name: user.name } : null;
    if (
      user?.status !== 'ACTIVE' ||
      !user.isPlatformOperator ||
      !verified.permissions.includes(PLATFORM_QUEUE_ADMIN)
    ) {
      throw new OperatorAccessError('PERMISSION_DENIED', identity);
    }
    if (!verified.amr.some((method) => MFA_AMR_VALUES.includes(method))) {
      throw new OperatorAccessError('MFA_REQUIRED', identity);
    }
    return { userId: user.id, name: user.name };
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Verificador pelo JWKS do emissor (descoberta OIDC), RS256/ES256, `iss`/`aud`/`exp`. */
export class JwksOperatorTokenVerifier implements OperatorTokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly options: {
      readonly issuer: string;
      readonly audience: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  async verify(token: string): Promise<VerifiedOperatorToken> {
    this.jwks ??= createRemoteJWKSet(new URL(await this.discoverJwksUri()));
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('sub ausente');
    return {
      subject: payload.sub,
      amr: strings(payload.amr),
      permissions: strings(payload.cf_platform_permissions),
    };
  }

  private async discoverJwksUri(): Promise<string> {
    const base = this.options.issuer.endsWith('/')
      ? this.options.issuer
      : `${this.options.issuer}/`;
    const response = await (this.options.fetch ?? fetch)(
      new URL('.well-known/openid-configuration', base).href,
      { redirect: 'error', signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error(`descoberta OIDC: HTTP ${String(response.status)}`);
    const document = (await response.json()) as { jwks_uri?: unknown };
    if (typeof document.jwks_uri !== 'string') throw new Error('descoberta OIDC sem jwks_uri');
    return document.jwks_uri;
  }
}

/** Operadores pela tabela de plataforma `users` (papel `cf_worker`, sem tenant). */
export class DatabaseOperatorDirectory implements OperatorDirectory {
  constructor(private readonly database: Pick<WorkerDatabase, 'platformTransaction'>) {}

  async findBySubject(subject: string): Promise<OperatorRecord | null> {
    const { rows } = await this.database.platformTransaction((client) =>
      client.query<{ id: string; name: string; status: string; is_platform_operator: boolean }>(
        'SELECT id, name, status::text AS status, is_platform_operator FROM users WHERE external_subject = $1',
        [subject],
      ),
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          name: row.name,
          status: row.status,
          isPlatformOperator: row.is_platform_operator,
        }
      : null;
  }
}
