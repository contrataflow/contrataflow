import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OidcIdentityProvider } from '@/bff/auth/oidc-provider';
import { codeChallenge } from '@/bff/auth/pkce';
import type { LoginStart, SessionRecord } from '@/bff/session/types';
import {
  IDP_CLIENT_ID,
  IDP_CLIENT_SECRET,
  IDP_ISSUER,
  IDP_REDIRECT_URI,
  createFakeIdp,
  idpKey,
} from '@test/support/fake-idp';
import type { FakeIdp } from '@test/support/fake-idp';

/* RN-IAM-01/04: Authorization Code + PKCE S256 com cliente confidencial e validação do id_token. */

const NOW = Date.parse('2026-10-14T12:00:00Z');

let clock: { now: number };
let idp: FakeIdp;
let provider: OidcIdentityProvider;

function create(issuer = IDP_ISSUER) {
  return new OidcIdentityProvider({
    issuer,
    clientId: IDP_CLIENT_ID,
    clientSecret: IDP_CLIENT_SECRET,
    scopes: 'openid profile email offline_access',
    redirectUri: IDP_REDIRECT_URI,
    postLogoutRedirectUri: 'http://localhost:3000/',
    fetch: idp.fetch,
    now: () => clock.now,
  });
}

beforeEach(async () => {
  clock = { now: NOW };
  idp = await createFakeIdp(() => clock.now);
  provider = create();
});

async function start(stepUp = false): Promise<LoginStart & { url: URL }> {
  const begin = await provider.beginLogin({ stepUp });
  idp.state.nonce = begin.nonce;
  return { ...begin, url: new URL(begin.redirectUrl) };
}

function callbackParams(state: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ code: 'codigo-1', state, ...extra });
}

describe('início do login (RN-IAM-01)', () => {
  it('302 para o authorization_endpoint com code, PKCE S256, state, nonce e escopos', async () => {
    const begin = await start();
    expect(`${begin.url.origin}${begin.url.pathname}`).toBe(
      'http://localhost:9080/application/o/authorize/',
    );
    expect(Object.fromEntries(begin.url.searchParams)).toEqual({
      response_type: 'code',
      client_id: IDP_CLIENT_ID,
      redirect_uri: IDP_REDIRECT_URI,
      scope: 'openid profile email offline_access',
      state: begin.state,
      nonce: begin.nonce,
      code_challenge: codeChallenge(begin.codeVerifier),
      code_challenge_method: 'S256',
    });
    // Segredos nunca na URL além do challenge.
    expect(begin.redirectUrl).not.toContain(begin.codeVerifier);
  });

  it('step-up força reautenticação no IdP (max_age=0)', async () => {
    const begin = await start(true);
    expect(begin.url.searchParams.get('max_age')).toBe('0');
  });

  it('descoberta de outro emissor (mix-up) ou IdP fora do ar: o login não começa', async () => {
    idp.state.discoveryIssuer = 'https://outro-idp.test/';
    await expect(provider.beginLogin({ stepUp: false })).rejects.toThrow();
    idp.state.down = true;
    await expect(create().beginLogin({ stepUp: false })).rejects.toThrow();
  });
});

describe('callback: troca do código e validação do id_token (RN-IAM-04)', () => {
  it('[Sucesso] troca com client_secret_basic e code_verifier; devolve tokens e claims', async () => {
    const begin = await start();
    const completion = await provider.completeLogin(callbackParams(begin.state), begin);
    expect(completion).toMatchObject({
      ok: true,
      login: {
        subject: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
        amr: ['pwd'],
        authTime: NOW - 5_000,
        tokens: {
          accessToken: 'access-token-opaco-para-o-teste',
          accessTokenExpiresAt: NOW + 300_000,
          refreshToken: 'refresh-token-do-teste',
        },
      },
    });
    const [request] = idp.tokenRequests;
    expect(request?.authorization).toBe(
      `Basic ${Buffer.from(`${IDP_CLIENT_ID}:${IDP_CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'codigo-1',
      redirect_uri: IDP_REDIRECT_URI,
      code_verifier: begin.codeVerifier,
    });
  });

  it('[Validação] id_token com nonce incorreto → NONCE_MISMATCH', async () => {
    const begin = await start();
    idp.state.nonce = 'nonce-de-outra-transacao';
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toEqual({
      ok: false,
      reason: 'NONCE_MISMATCH',
    });
  });

  it.each([
    ['iss de outro emissor', { iss: 'https://outro.test/' }],
    ['aud de outro cliente', { aud: 'outro-cliente' }],
    ['azp de outro cliente', { azp: 'outro-cliente' }],
    ['expirado além da tolerância', { exp: Math.floor(NOW / 1000) - 61 }],
    ['iat ausente', { iat: undefined }],
  ])('[Validação] %s → TOKEN_INVALID', async (_case, claims) => {
    const begin = await start();
    idp.state.claims = claims;
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
  });

  it('[Validação] assinatura de chave fora do JWKS ou alg none → TOKEN_INVALID', async () => {
    const begin = await start();
    idp.state.signingKey = await idpKey('kid-1');
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toMatchObject({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: IDP_ISSUER, aud: IDP_CLIENT_ID, sub: 'x', nonce: begin.nonce }),
    ).toString('base64url');
    idp.state.tokenBody = { access_token: 'a', expires_in: 60, id_token: `${header}.${payload}.` };
    const second = await start();
    expect(await provider.completeLogin(callbackParams(second.state), second)).toMatchObject({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
  });

  it('[Validação] resposta sem id_token ou sem access_token → TOKEN_INVALID', async () => {
    const begin = await start();
    idp.state.tokenBody = { access_token: 'a', expires_in: 60 };
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toMatchObject({
      reason: 'TOKEN_INVALID',
    });
    idp.state.tokenBody = { token_type: 'Bearer' };
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toMatchObject({
      reason: 'TOKEN_INVALID',
    });
    expect(await provider.completeLogin(new URLSearchParams({ state: 'x' }), begin)).toMatchObject({
      reason: 'TOKEN_INVALID',
    });
  });

  it('[Duplicidade] código já usado: o IdP recusa (400 invalid_grant) → TOKEN_INVALID', async () => {
    const begin = await start();
    idp.state.tokenStatus = 400;
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    expect(provider.lastFailure).toEqual({ providerStatus: 400 });
  });

  it('[Falha de integração] token endpoint fora do ar ou 5xx → PROVIDER_UNAVAILABLE', async () => {
    const begin = await start();
    idp.state.tokenStatus = 503;
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toEqual({
      ok: false,
      reason: 'PROVIDER_UNAVAILABLE',
    });
    expect(provider.lastFailure).toEqual({ providerStatus: 503 });
    idp.state.down = true;
    expect(await provider.completeLogin(callbackParams(begin.state), begin)).toMatchObject({
      reason: 'PROVIDER_UNAVAILABLE',
    });
    expect(provider.lastFailure).toEqual({ providerStatus: null });
  });

  it('[Falha de integração] descoberta indisponível no callback → PROVIDER_UNAVAILABLE', async () => {
    idp.state.down = true;
    const fresh = create();
    expect(
      await fresh.completeLogin(callbackParams('s'), { state: 's', nonce: 'n', codeVerifier: 'v' }),
    ).toEqual({ ok: false, reason: 'PROVIDER_UNAVAILABLE' });
  });

  it('FA-05: erro devolvido pelo Authentik', async () => {
    const begin = await start();
    expect(
      await provider.completeLogin(
        new URLSearchParams({ error: 'access_denied', state: begin.state }),
        begin,
      ),
    ).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    expect(
      await provider.completeLogin(
        new URLSearchParams({ error: 'temporarily_unavailable', state: begin.state }),
        begin,
      ),
    ).toEqual({ ok: false, reason: 'PROVIDER_UNAVAILABLE' });
  });

  it('chave rotacionada: o JWKS é rebuscado para o kid novo (após o intervalo de 30 s)', async () => {
    const begin = await start();
    await provider.completeLogin(callbackParams(begin.state), begin);
    const rotated = await idpKey('kid-2', 'ES256');
    idp.state.keys = [...idp.state.keys, rotated];
    idp.state.signingKey = rotated;
    // O cache de JWKS do jose usa o relógio do sistema.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const second = await start();
      expect(await provider.completeLogin(callbackParams(second.state), second)).toMatchObject({
        ok: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renovação e logout', () => {
  const record = (refreshToken: string | null) =>
    ({
      tokens: {
        accessToken: 'antigo',
        accessTokenExpiresAt: NOW,
        refreshToken,
        idToken: 'id-antigo',
      },
    }) as SessionRecord;

  it('refresh_token: novos tokens (com rotação); invalid_grant; falha transitória', async () => {
    idp.state.tokenBody = { access_token: 'novo', expires_in: 120, refresh_token: 'r2' };
    expect(await provider.refresh(record('r1'))).toEqual({
      kind: 'ok',
      tokens: {
        accessToken: 'novo',
        accessTokenExpiresAt: NOW + 120_000,
        refreshToken: 'r2',
        idToken: 'id-antigo',
      },
    });
    expect(Object.fromEntries(idp.tokenRequests.at(-1)?.form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
    });
    idp.state.tokenBody = { access_token: 'novo2' };
    expect(await provider.refresh(record('r1'))).toMatchObject({
      kind: 'ok',
      tokens: { refreshToken: 'r1', accessTokenExpiresAt: NOW + 300_000 },
    });
    idp.state.tokenBody = {};
    expect(await provider.refresh(record('r1'))).toEqual({ kind: 'transient' });
    idp.state.tokenStatus = 400;
    expect(await provider.refresh(record('r1'))).toEqual({ kind: 'invalid_grant' });
    idp.state.tokenStatus = 502;
    expect(await provider.refresh(record('r1'))).toEqual({ kind: 'transient' });
    expect(await provider.refresh(record(null))).toEqual({ kind: 'invalid_grant' });
    idp.state.down = true;
    expect(await create().refresh(record('r1'))).toEqual({ kind: 'transient' });
  });

  it('end-session sem id_token_hint (o token nunca vai à URL do navegador)', async () => {
    expect(provider.endSessionUrl()).toBeNull();
    await start();
    const url = new URL(provider.endSessionUrl() ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: IDP_CLIENT_ID,
      post_logout_redirect_uri: 'http://localhost:3000/',
    });
  });
});
