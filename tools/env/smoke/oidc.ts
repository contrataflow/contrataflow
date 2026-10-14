// Login OIDC de ponta a ponta contra o Authentik local (smoke da US-078): Authorization Code +
// PKCE S256 com o cliente confidencial do BFF, percorrendo os fluxos do Authentik pela API do
// executor (a mesma que a interface usa). Valida o id_token pela JWKS (RS256), `iss`, `aud` e
// `nonce` — o mesmo contrato que o BFF implementa na US-087.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** Cookies por nome (o Authentik usa poucos e todos no mesmo host). */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export interface JwtParts {
  readonly header: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signingInput: string;
  readonly signature: Buffer;
}

export function decodeJwt(token: string): JwtParts {
  const [header = '', payload = '', signature = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

interface Challenge {
  readonly component: string;
  readonly to?: string;
  readonly password_fields?: boolean;
  readonly token?: string;
  readonly error_message?: string;
  readonly response_errors?: unknown;
}

export interface OidcLoginOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: FetchLike;
}

export interface OidcLoginResult {
  readonly idTokenHeader: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
  readonly scopes: readonly string[];
  readonly hasRefreshToken: boolean;
}

interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly code_challenge_methods_supported?: readonly string[];
}

export async function oidcLogin(options: OidcLoginOptions): Promise<OidcLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jar = new CookieJar();
  const discovery = (await (
    await fetchImpl(`${options.issuer}.well-known/openid-configuration`)
  ).json()) as Discovery;
  if (!discovery.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('o provider não anuncia PKCE S256');
  }

  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    scope: 'openid profile email offline_access',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const request = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const cookies = jar.header();
    if (cookies) headers.set('Cookie', cookies);
    const csrf = jar.get('authentik_csrf');
    if (csrf) headers.set('X-authentik-CSRF', csrf);
    const response = await fetchImpl(url, { ...init, headers, redirect: 'manual' });
    jar.store(response);
    return response;
  };

  /** Executa um fluxo do Authentik até o redirecionamento final (`xak-flow-redirect`). */
  const runFlow = async (origin: string, slug: string, query: string): Promise<string> => {
    const api = `${origin}/api/v3/flows/executor/${slug}/?query=${encodeURIComponent(query)}`;
    // O executor responde POST com 302 para o próprio GET (às vezes encadeado); um redirecionamento
    // para fora do executor encerra o fluxo.
    const readChallenge = async (first: Response): Promise<Challenge> => {
      let response = first;
      for (let hop = 0; hop < 10; hop += 1) {
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) {
          return (await response.json()) as Challenge;
        }
        const next = new URL(location, api);
        if (!next.pathname.startsWith('/api/v3/flows/executor/')) {
          return { component: 'xak-flow-redirect', to: next.toString() };
        }
        response = await request(next.toString());
      }
      throw new Error(`redirecionamentos demais no executor do fluxo ${slug}`);
    };
    let current = await readChallenge(await request(api));
    for (let step = 0; step < 10; step += 1) {
      let body: Record<string, unknown>;
      switch (current.component) {
        case 'xak-flow-redirect':
          return current.to ?? '/';
        case 'ak-stage-identification':
          body = {
            component: current.component,
            uid_field: options.username,
            ...(current.password_fields ? { password: options.password } : {}),
          };
          break;
        case 'ak-stage-password':
          body = { component: current.component, password: options.password };
          break;
        case 'ak-stage-consent':
          body = { component: current.component, token: current.token };
          break;
        default:
          throw new Error(
            `etapa inesperada no fluxo ${slug}: ${current.component} ${current.error_message ?? JSON.stringify(current.response_errors ?? '')}`,
          );
      }
      current = await readChallenge(
        await request(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }
    throw new Error(`fluxo ${slug} não terminou em 10 etapas`);
  };

  // Navega como um navegador: redirecionamentos HTTP e páginas de fluxo (/if/flow/<slug>/).
  let url = authorize.toString();
  let code: string | undefined;
  for (let hop = 0; hop < 20 && !code; hop += 1) {
    if (url.startsWith(options.redirectUri)) {
      const params = new URL(url).searchParams;
      if (params.get('state') !== state) throw new Error('state divergente no callback');
      code = params.get('code') ?? undefined;
      if (!code)
        throw new Error(`callback sem code: ${params.get('error') ?? 'erro desconhecido'}`);
      break;
    }
    const response = await request(url);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    const current = new URL(url);
    const flow = /^\/if\/flow\/([^/]+)\/?$/.exec(current.pathname);
    if (response.status === 200 && flow?.[1]) {
      url = new URL(
        await runFlow(current.origin, flow[1], current.search.slice(1)),
        url,
      ).toString();
      continue;
    }
    throw new Error(`resposta inesperada em ${current.pathname}: HTTP ${response.status}`);
  }
  if (!code) throw new Error('o login não chegou ao redirect_uri');

  const tokenResponse = await fetchImpl(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      code_verifier: verifier,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString(),
  });
  const tokens = (await tokenResponse.json()) as {
    id_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !tokens.id_token) {
    throw new Error(`troca do code falhou: ${tokens.error ?? `HTTP ${tokenResponse.status}`}`);
  }

  const idToken = decodeJwt(tokens.id_token);
  const jwks = (await (await fetchImpl(discovery.jwks_uri)).json()) as {
    keys: (JsonWebKey & { kid?: string })[];
  };
  const jwk = jwks.keys.find((key) => key.kid === idToken.header.kid);
  if (idToken.header.alg !== 'RS256' || !jwk) {
    throw new Error(`id_token com alg ${String(idToken.header.alg)} ou kid desconhecido`);
  }
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verify('sha256', Buffer.from(idToken.signingInput), key, idToken.signature)) {
    throw new Error('assinatura do id_token inválida');
  }
  const claims = idToken.payload;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== options.issuer) throw new Error(`iss inesperado: ${String(claims.iss)}`);
  if (!audience.includes(options.clientId)) throw new Error('aud não contém o client_id');
  if (claims.nonce !== nonce) throw new Error('nonce divergente');
  return {
    idTokenHeader: idToken.header,
    claims,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    hasRefreshToken: Boolean(tokens.refresh_token),
  };
}
