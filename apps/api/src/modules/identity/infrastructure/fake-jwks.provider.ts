import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { TokenVerificationError } from '#shared/auth/ports.js';
import type { TokenVerifierPort, VerifiedToken } from '#shared/auth/ports.js';

export interface FakeJwksOptions {
  /** Chave HS256; `null` → aleatória por processo (nenhum token externo é aceito). */
  readonly signingKey: string | null;
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly clockToleranceSeconds: number;
  readonly now?: () => number;
}

export interface FakeTokenClaims {
  readonly sub: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  /** Segundos desde a época; padrão: agora + 5 min. */
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly auth_time?: number;
  readonly amr?: readonly string[];
  readonly email?: string;
  readonly email_verified?: boolean;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verificador de token determinístico com chave simétrica (FA-02 da US-080) atrás da porta
 * `TokenVerifierPort`: testes e modo de identidade fake de local/dev/test. Em staging/produção o
 * verificador é sempre o `JwksTokenVerifier` (US-087). Valida assinatura, `alg`, `iss`, `aud`,
 * `exp` e `nbf` com tolerância.
 */
export class FakeJwksProvider implements TokenVerifierPort {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(private readonly options: FakeJwksOptions) {
    this.key = options.signingKey ? Buffer.from(options.signingKey, 'utf8') : randomBytes(32);
    this.now = options.now ?? Date.now;
  }

  /** Emite um token (testes e desenvolvimento local com a chave configurada). */
  sign(claims: FakeTokenClaims): string {
    const nowSeconds = Math.floor(this.now() / 1000);
    const payload = {
      iss: this.options.issuer,
      aud: this.options.audiences[0],
      iat: nowSeconds,
      exp: nowSeconds + 300,
      ...claims,
    };
    const unsigned = `${base64url(JSON.stringify(HEADER))}.${base64url(JSON.stringify(payload))}`;
    return `${unsigned}.${this.signature(unsigned).toString('base64url')}`;
  }

  verify(token: string): Promise<VerifiedToken> {
    // Exceção no executor vira rejeição da promessa.
    return new Promise((resolve) => {
      resolve(this.verifySync(token));
    });
  }

  private verifySync(token: string): VerifiedToken {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenVerificationError('INVALID');
    const [header, payload, signature] = parts as [string, string, string];

    const expected = this.signature(`${header}.${payload}`);
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new TokenVerificationError('INVALID');
    }

    let claims: FakeTokenClaims;
    try {
      const parsedHeader = decodeJson(header) as { alg?: unknown };
      if (parsedHeader.alg !== HEADER.alg) throw new TokenVerificationError('INVALID');
      claims = decodeJson(payload) as FakeTokenClaims;
    } catch {
      throw new TokenVerificationError('INVALID');
    }

    const nowSeconds = this.now() / 1000;
    const tolerance = this.options.clockToleranceSeconds;
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : (claims.aud ?? []);
    if (
      typeof claims.sub !== 'string' ||
      claims.sub === '' ||
      claims.iss !== this.options.issuer ||
      !audiences.some((audience) => this.options.audiences.includes(audience)) ||
      typeof claims.exp !== 'number' ||
      (claims.nbf !== undefined && claims.nbf > nowSeconds + tolerance)
    ) {
      throw new TokenVerificationError('INVALID');
    }
    if (claims.exp <= nowSeconds - tolerance) throw new TokenVerificationError('EXPIRED');

    return {
      subject: claims.sub,
      amr: Array.isArray(claims.amr) ? claims.amr.filter((value) => typeof value === 'string') : [],
      authTime: typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : null,
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
    };
  }

  private signature(input: string): Buffer {
    return createHmac('sha256', this.key).update(input).digest();
  }
}
