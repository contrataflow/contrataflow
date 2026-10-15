// Authentik simulado para os testes do cliente OIDC do BFF (US-087): descoberta, JWKS, token
// endpoint e emissão de `id_token` assinado (RS256/ES256) com chaves geradas no teste.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { vi } from 'vitest';

import { requestUrl } from './render';

export const IDP_ISSUER = 'http://localhost:9080/application/o/contrataflow/';
export const IDP_CLIENT_ID = 'contrataflow-web';
export const IDP_CLIENT_SECRET = 'segredo-do-cliente';
export const IDP_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
const AUTHORIZE = 'http://localhost:9080/application/o/authorize/';
const TOKEN = 'http://localhost:9080/application/o/token/';
const JWKS = 'http://localhost:9080/application/o/contrataflow/jwks/';
const END_SESSION = 'http://localhost:9080/application/o/contrataflow/end-session/';
const REVOKE = 'http://localhost:9080/application/o/revoke/';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface IdpKey {
  readonly kid: string;
  readonly alg: 'RS256' | 'ES256';
  readonly privateKey: PrivateKey;
  readonly jwk: JWK;
}

export async function idpKey(kid: string, alg: 'RS256' | 'ES256' = 'RS256'): Promise<IdpKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { kid, alg, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

export interface TokenRequestRecord {
  readonly authorization: string | null;
  readonly form: URLSearchParams;
}

export interface FakeIdp {
  readonly fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly tokenRequests: TokenRequestRecord[];
  /** Pedidos ao endpoint de revogação (RFC 7009 — US-088). */
  readonly revocations: TokenRequestRecord[];
  /** Estado mutável do IdP (chaves, respostas e falhas). */
  readonly state: {
    keys: IdpKey[];
    signingKey: IdpKey;
    discoveryIssuer: string;
    /** Claims extras/alteradas do próximo `id_token` (`undefined` remove a claim). */
    claims: Readonly<Record<string, unknown>>;
    /** Resposta do token endpoint: status e corpo (padrão: sucesso com tokens). */
    tokenStatus: number;
    tokenBody: Record<string, unknown> | null;
    /** Derruba descoberta/JWKS/token (erro de rede). */
    down: boolean;
    /** Nonce da transação em curso (o `id_token` o devolve). */
    nonce: string;
    /** Status do endpoint de revogação; `null` = não publicado na descoberta. */
    revokeStatus: number | null;
  };
  signIdToken(claims?: JWTPayload): Promise<string>;
}

export async function createFakeIdp(now: () => number): Promise<FakeIdp> {
  const key = await idpKey('kid-1');
  const tokenRequests: TokenRequestRecord[] = [];
  const revocations: TokenRequestRecord[] = [];
  const state: FakeIdp['state'] = {
    keys: [key],
    signingKey: key,
    discoveryIssuer: IDP_ISSUER,
    claims: {},
    tokenStatus: 200,
    tokenBody: null,
    down: false,
    nonce: '',
    revokeStatus: 200,
  };

  const signIdToken = (claims: JWTPayload = {}) => {
    const seconds = Math.floor(now() / 1000);
    return new SignJWT({
      iss: IDP_ISSUER,
      aud: IDP_CLIENT_ID,
      sub: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
      iat: seconds,
      exp: seconds + 300,
      auth_time: seconds - 5,
      nonce: state.nonce,
      amr: ['pwd'],
      email: 'claudia@saojose.sp.gov.br',
      ...state.claims,
      ...claims,
    })
      .setProtectedHeader({ alg: state.signingKey.alg, kid: state.signingKey.kid, typ: 'JWT' })
      .sign(state.signingKey.privateKey);
  };

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (state.down) throw new TypeError('fetch failed');
    const url = requestUrl(input);
    if (url === `${IDP_ISSUER}.well-known/openid-configuration`) {
      return Response.json({
        issuer: state.discoveryIssuer,
        authorization_endpoint: AUTHORIZE,
        token_endpoint: TOKEN,
        jwks_uri: JWKS,
        end_session_endpoint: END_SESSION,
        ...(state.revokeStatus === null ? {} : { revocation_endpoint: REVOKE }),
      });
    }
    if (url === REVOKE) {
      revocations.push({
        authorization: new Headers(init?.headers).get('authorization'),
        form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      });
      return new Response(null, { status: state.revokeStatus ?? 404 });
    }
    if (url === JWKS) return Response.json({ keys: state.keys.map((item) => item.jwk) });
    if (url === TOKEN) {
      const headers = new Headers(init?.headers);
      tokenRequests.push({
        authorization: headers.get('authorization'),
        form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      });
      if (state.tokenStatus !== 200) {
        return Response.json({ error: 'invalid_grant' }, { status: state.tokenStatus });
      }
      return Response.json(
        state.tokenBody ?? {
          access_token: 'access-token-opaco-para-o-teste',
          token_type: 'Bearer',
          expires_in: 300,
          refresh_token: 'refresh-token-do-teste',
          id_token: await signIdToken(),
        },
      );
    }
    return new Response('not found', { status: 404 });
  });

  return { fetch: fetchMock, tokenRequests, revocations, state, signIdToken };
}
