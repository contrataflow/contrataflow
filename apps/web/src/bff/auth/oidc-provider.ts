import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

import { codeChallenge, newLoginSecrets } from './pkce';
import { IdentityProviderUnavailableError } from '../session/types';
import type {
  IdentityProvider,
  LoginCompletion,
  LoginSecrets,
  LoginStart,
  RefreshResult,
  RevocationResult,
  SessionRecord,
  SessionTokens,
} from '../session/types';

/*
 * Cliente OIDC confidencial do BFF no Authentik (DEC-130 · ADR-003 · authentication.md §3):
 * Authorization Code + PKCE S256 (RN-IAM-01), troca do código com o segredo do cliente
 * (`client_secret_basic`) e validação do `id_token` (RN-IAM-04): assinatura pelo JWKS (RS256/ES256,
 * `none` recusado), `iss`, `aud` (o `client_id`), `azp`, `exp`, `iat` e `nonce`, tolerância 60 s.
 */

export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256'];
const DISCOVERY_TTL_MS = 60 * 60_000;
/** Tempo-limite das chamadas ao IdP durante o logout (RN-IAM-20). */
const LOGOUT_TIMEOUT_MS = 2_000;

export interface OidcProviderOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly clockToleranceSeconds?: number;
}

interface Discovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
  readonly revocation_endpoint?: string;
}

function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  return ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'].every(
    (key) => typeof doc[key] === 'string',
  );
}

type TokenResponse =
  | { readonly kind: 'ok'; readonly body: Record<string, unknown> }
  /** 4xx do IdP (`invalid_grant` — código reutilizado/expirado, refresh revogado). */
  | { readonly kind: 'rejected'; readonly status: number }
  /** 5xx, rede ou timeout. */
  | { readonly kind: 'unavailable'; readonly status: number | null };

/** Falha na troca do código ou na validação, com o status do IdP para o log (sem o corpo). */
export interface OidcFailureDetail {
  readonly providerStatus: number | null;
}

function equalSecrets(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly kind = 'oidc' as const;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private discovery: { readonly doc: Discovery; readonly fetchedAt: number } | null = null;
  private jwks: {
    readonly uri: string;
    readonly keySet: ReturnType<typeof createRemoteJWKSet>;
  } | null = null;
  /** Status do IdP na última falha de troca (lido pelo handler para o log). */
  lastFailure: OidcFailureDetail | null = null;
  private discoveryFailed = false;

  constructor(private readonly options: OidcProviderOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /**
   * Idade da descoberta OIDC em cache para o `/health/ready` (US-085 · observability.md §6.2) e se
   * a última tentativa de carregá-la falhou.
   */
  discoveryState(): { readonly ageSeconds: number | null; readonly lastRefreshFailed: boolean } {
    return {
      ageSeconds: this.discovery
        ? Math.floor((this.now() - this.discovery.fetchedAt) / 1_000)
        : null,
      lastRefreshFailed: this.discoveryFailed,
    };
  }

  /** Carrega (ou renova, se vencida) a descoberta; falha só marca o estado. */
  async warmUp(timeoutMs?: number): Promise<void> {
    await this.discover(timeoutMs).catch(() => undefined);
  }

  async beginLogin(input: {
    readonly stepUp: boolean;
    readonly reauthenticate?: boolean;
  }): Promise<LoginStart> {
    const doc = await this.discover();
    const secrets = newLoginSecrets();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('scope', this.options.scopes);
    url.searchParams.set('state', secrets.state);
    url.searchParams.set('nonce', secrets.nonce);
    url.searchParams.set('code_challenge', codeChallenge(secrets.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Step-up (US-090) e entrada após expiração (RN-IAM-32): reautenticação no IdP sem
    // reaproveitar a sessão dele — a ociosidade não é contornada pelo SSO.
    if (input.stepUp || input.reauthenticate === true) url.searchParams.set('max_age', '0');
    if (input.reauthenticate === true) url.searchParams.set('prompt', 'login');
    return { ...secrets, redirectUrl: url.href };
  }

  async completeLogin(params: URLSearchParams, secrets: LoginSecrets): Promise<LoginCompletion> {
    this.lastFailure = null;
    const error = params.get('error');
    if (error !== null) {
      // FA-05: erro devolvido pelo Authentik (`access_denied`, `temporarily_unavailable`…).
      const unavailable = error === 'temporarily_unavailable' || error === 'server_error';
      return { ok: false, reason: unavailable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR' };
    }
    const code = params.get('code');
    if (!code) return { ok: false, reason: 'TOKEN_INVALID' };

    let doc: Discovery;
    try {
      doc = await this.discover();
    } catch {
      this.lastFailure = { providerStatus: null };
      return { ok: false, reason: 'PROVIDER_UNAVAILABLE' };
    }
    const exchange = await this.tokenRequest(doc, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      code_verifier: secrets.codeVerifier,
    });
    if (exchange.kind !== 'ok') {
      this.lastFailure = { providerStatus: exchange.status };
      return {
        ok: false,
        reason: exchange.kind === 'unavailable' ? 'PROVIDER_UNAVAILABLE' : 'TOKEN_INVALID',
      };
    }

    const tokens = this.tokensFrom(exchange.body, null);
    if (!tokens?.idToken) return { ok: false, reason: 'TOKEN_INVALID' };
    let claims: JWTPayload;
    try {
      claims = await this.verifyIdToken(doc, tokens.idToken);
    } catch (verification) {
      const unreachable =
        verification instanceof errors.JWKSTimeout || !(verification instanceof errors.JOSEError);
      return { ok: false, reason: unreachable ? 'PROVIDER_UNAVAILABLE' : 'TOKEN_INVALID' };
    }
    if (typeof claims.nonce !== 'string' || !equalSecrets(claims.nonce, secrets.nonce)) {
      return { ok: false, reason: 'NONCE_MISMATCH' };
    }
    if (claims.azp !== undefined && claims.azp !== this.options.clientId) {
      return { ok: false, reason: 'TOKEN_INVALID' };
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      return { ok: false, reason: 'TOKEN_INVALID' };
    }
    return {
      ok: true,
      login: {
        subject: claims.sub,
        tokens,
        amr: stringArray(claims.amr),
        authTime: typeof claims.auth_time === 'number' ? claims.auth_time * 1000 : null,
      },
    };
  }

  async refresh(record: SessionRecord): Promise<RefreshResult> {
    const refreshToken = record.tokens.refreshToken;
    if (!refreshToken) return { kind: 'invalid_grant' };
    let doc: Discovery;
    try {
      doc = await this.discover();
    } catch {
      return { kind: 'transient' };
    }
    const response = await this.tokenRequest(doc, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (response.kind === 'rejected') return { kind: 'invalid_grant' };
    if (response.kind === 'unavailable') return { kind: 'transient' };
    const tokens = this.tokensFrom(response.body, record.tokens);
    return tokens ? { kind: 'ok', tokens } : { kind: 'transient' };
  }

  /**
   * Revogação do refresh token no logout (RFC 7009 · RN-IAM-20): melhor esforço com tempo-limite
   * de 2 s — IdP lento ou fora do ar não segura o logout local (FA-06).
   */
  async revokeRefreshToken(record: SessionRecord): Promise<RevocationResult> {
    const refreshToken = record.tokens.refreshToken;
    if (!refreshToken) return 'skipped';
    let doc: Discovery;
    try {
      doc = await this.discover(LOGOUT_TIMEOUT_MS);
    } catch {
      return 'unavailable';
    }
    if (!doc.revocation_endpoint) return 'skipped';
    try {
      const response = await this.fetch(doc.revocation_endpoint, {
        method: 'POST',
        headers: {
          authorization: this.clientAuthorization(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }).toString(),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      // 4xx (token já inválido, tipo não suportado): nada a revogar; 5xx: IdP com problema.
      return response.status >= 500 ? 'unavailable' : 'revoked';
    } catch {
      return 'unavailable';
    }
  }

  /**
   * URL do *RP-initiated logout* (`end_session_endpoint`) com `client_id` e
   * `post_logout_redirect_uri` (`/entrar?motivo=saiu`, registrado no Authentik como `logout`).
   * Sem `id_token_hint` (DEC-070): o token nunca vai para uma URL do navegador — em computador
   * compartilhado ficaria no histórico. O endpoint é por aplicação, então o Authentik identifica
   * o cliente sem ele.
   */
  async endSessionUrl(): Promise<string | null> {
    let doc: Discovery;
    try {
      doc = await this.discover(LOGOUT_TIMEOUT_MS);
    } catch (error) {
      throw new IdentityProviderUnavailableError({ cause: error });
    }
    const endpoint = doc.end_session_endpoint;
    if (!endpoint) return null;
    const url = new URL(endpoint);
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.options.postLogoutRedirectUri);
    return url.href;
  }

  private tokensFrom(
    body: Record<string, unknown>,
    previous: SessionTokens | null,
  ): SessionTokens | null {
    const accessToken = body.access_token;
    const expiresIn = body.expires_in;
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    const lifetimeSeconds = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 300;
    return {
      accessToken,
      accessTokenExpiresAt: this.now() + lifetimeSeconds * 1000,
      // Rotação do refresh token (RN-IAM-25): o novo substitui o anterior quando vier.
      refreshToken:
        typeof body.refresh_token === 'string'
          ? body.refresh_token
          : (previous?.refreshToken ?? null),
      idToken: typeof body.id_token === 'string' ? body.id_token : (previous?.idToken ?? null),
    };
  }

  private async verifyIdToken(doc: Discovery, idToken: string): Promise<JWTPayload> {
    if (this.jwks?.uri !== doc.jwks_uri) {
      this.jwks = {
        uri: doc.jwks_uri,
        // Cache de 10 min e no máximo uma busca a cada 30 s (padrões do jose).
        keySet: createRemoteJWKSet(new URL(doc.jwks_uri), {
          timeoutDuration: this.options.timeoutMs ?? 5_000,
          [customFetch]: (url, init) => this.fetch(url, init),
        }),
      };
    }
    const { payload } = await jwtVerify(idToken, this.jwks.keySet, {
      issuer: this.options.issuer,
      audience: this.options.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
      clockTolerance: this.options.clockToleranceSeconds ?? 60,
      currentDate: new Date(this.now()),
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
    });
    return payload;
  }

  private async discover(timeoutMs = this.options.timeoutMs ?? 5_000): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) {
      return this.discovery.doc;
    }
    const base = this.options.issuer.endsWith('/')
      ? this.options.issuer
      : `${this.options.issuer}/`;
    try {
      const response = await this.fetch(new URL('.well-known/openid-configuration', base), {
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Descoberta OIDC: HTTP ${response.status}`);
      const doc: unknown = await response.json();
      // O documento precisa ser do mesmo emissor configurado (mix-up).
      if (!isDiscovery(doc) || doc.issuer !== this.options.issuer) {
        throw new Error('Documento de descoberta OIDC inválido');
      }
      this.discovery = { doc, fetchedAt: this.now() };
      this.discoveryFailed = false;
      return doc;
    } catch (error) {
      this.discoveryFailed = true;
      throw error;
    }
  }

  /** `client_secret_basic` (RFC 6749 §2.3.1). */
  private clientAuthorization(): string {
    const credentials = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');
    return `Basic ${credentials}`;
  }

  private async tokenRequest(
    doc: Discovery,
    form: Readonly<Record<string, string>>,
  ): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.fetch(doc.token_endpoint, {
        method: 'POST',
        headers: {
          authorization: this.clientAuthorization(),
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      return { kind: 'unavailable', status: null };
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      return { kind: 'unavailable', status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'rejected', status: response.status };
    }
    try {
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return { kind: 'rejected', status: 200 };
      return { kind: 'ok', body: body as Record<string, unknown> };
    } catch {
      return { kind: 'unavailable', status: response.status };
    }
  }
}
