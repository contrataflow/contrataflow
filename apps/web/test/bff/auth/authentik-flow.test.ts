import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthentikPasswordLogin, CookieJar } from '@/bff/auth/authentik-flow';
import { newLoginSecrets } from '@/bff/auth/pkce';
import type { IdentityProvider, LoginFailureReason } from '@/bff/session/types';
import {
  AK_AUTHORIZE,
  AK_CALLBACK,
  AK_INVALIDATION_FLOW,
  AK_LOGIN_FLOW,
  createFakeFlowIdp,
} from '@test/support/authentik-flow';
import type { FakeFlowIdp } from '@test/support/authentik-flow';

/*
 * Cliente do executor de fluxos do Authentik (login nativo — DEC-187) contra respostas gravadas do
 * Authentik 2026.8.3: sucesso, credencial inválida, bloqueio, MFA, acesso negado e IdP fora. O
 * cliente OIDC é simulado (tem testes próprios): aqui interessa o caminho até o código.
 */

const CREDENTIALS = { username: 'requisitante.a', password: 'senha-correta' };

function stubIdentity() {
  const completions: URLSearchParams[] = [];
  const state: { fail: LoginFailureReason | null } = { fail: null };
  const identity: Pick<IdentityProvider, 'beginLogin' | 'completeLogin'> = {
    beginLogin: vi.fn(() => {
      const secrets = newLoginSecrets();
      const url = new URL(AK_AUTHORIZE);
      url.searchParams.set('client_id', 'contrataflow-web');
      url.searchParams.set('redirect_uri', AK_CALLBACK);
      url.searchParams.set('state', secrets.state);
      return Promise.resolve({ ...secrets, redirectUrl: url.href });
    }),
    completeLogin: vi.fn((params: URLSearchParams) => {
      completions.push(params);
      if (state.fail) return Promise.resolve({ ok: false as const, reason: state.fail });
      return Promise.resolve({
        ok: true as const,
        login: {
          subject: 'uuid-requisitante',
          tokens: {
            accessToken: 'access',
            accessTokenExpiresAt: 0,
            refreshToken: 'refresh',
            idToken: 'id',
          },
          amr: ['pwd'],
          authTime: null,
        },
      });
    }),
  };
  return { identity, completions, state };
}

let idp: FakeFlowIdp;
let oidc: ReturnType<typeof stubIdentity>;
let client: AuthentikPasswordLogin;

beforeEach(() => {
  idp = createFakeFlowIdp();
  oidc = stubIdentity();
  client = new AuthentikPasswordLogin({
    issuerUrl: 'http://localhost:9080/application/o/contrataflow/',
    appOrigin: 'http://localhost:3000',
    redirectUri: AK_CALLBACK,
    loginFlowSlug: AK_LOGIN_FLOW,
    invalidationFlowSlug: AK_INVALIDATION_FLOW,
    identity: oidc.identity,
    fetch: idp.fetch,
  });
});

const executorCalls = () => idp.calls.filter((call) => call.url.includes(AK_LOGIN_FLOW));
const invalidations = () => idp.calls.filter((call) => call.url.includes(AK_INVALIDATION_FLOW));

describe('AuthentikPasswordLogin — executor de fluxos (DEC-187)', () => {
  it('[Sucesso] usuário e senha: troca o código do authorize e encerra a sessão do IdP', async () => {
    const step = await client.authenticate(CREDENTIALS);
    expect(step).toMatchObject({ kind: 'authenticated', login: { subject: 'uuid-requisitante' } });
    // Identificação com a senha na mesma etapa; os 302 do executor seguidos com GET.
    expect(executorCalls().map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    const post = executorCalls()[1];
    expect(post?.body).toEqual({
      component: 'ak-stage-identification',
      uid_field: 'requisitante.a',
      password: 'senha-correta',
    });
    // Cookies da transação e o cabeçalho CSRF do Authentik.
    expect(post?.headers.get('cookie')).toContain('authentik_session=sess-1');
    expect(post?.headers.get('X-authentik-CSRF')).toBe('csrf-token');
    // Código e state do redirecionamento para o callback, sem segui-lo.
    expect(oidc.completions[0]?.get('code')).toBe('code-sess-1');
    expect(idp.calls.some((call) => call.url.startsWith(AK_CALLBACK))).toBe(false);
    // Nada fica aberto no IdP.
    expect(invalidations()).toHaveLength(1);
    expect(idp.sessions.size).toBe(0);
    // A senha só vai para o executor de fluxos.
    const others = idp.calls.filter((call) => call !== post);
    expect(JSON.stringify(others.map((call) => [call.url, call.body]))).not.toContain(
      'senha-correta',
    );
  });

  it('[Validação] senha errada → credencial inválida, sem authorize', async () => {
    const step = await client.authenticate({ ...CREDENTIALS, password: 'errada' });
    expect(step).toEqual({ kind: 'invalid_credentials' });
    expect(idp.calls.some((call) => call.url.startsWith(AK_AUTHORIZE))).toBe(false);
  });

  it('[Validação] senha numa etapa separada: a mesma senha vai uma vez à etapa de senha', async () => {
    idp.state.passwordStage = true;
    expect((await client.authenticate(CREDENTIALS)).kind).toBe('authenticated');
    const bodies = executorCalls().map((call) => call.body?.component ?? null);
    expect(bodies).toEqual([null, 'ak-stage-identification', null, 'ak-stage-password', null]);
    idp.state.password = 'outra';
    expect(await client.authenticate(CREDENTIALS)).toEqual({ kind: 'invalid_credentials' });
  });

  it('[Permissão] reputação no limite: o flow nega o acesso → bloqueado, sem sessão no IdP', async () => {
    idp.state.locked = true;
    expect(await client.authenticate(CREDENTIALS)).toEqual({ kind: 'locked' });
    expect(oidc.completions).toHaveLength(0);
    expect([...idp.sessions.values()].some((session) => session.authenticated)).toBe(false);
  });

  it('[Sucesso] MFA: etapa de código, código errado mantém a transação, o certo conclui', async () => {
    idp.state.mfaCode = '123456';
    const first = await client.authenticate(CREDENTIALS);
    expect(first).toMatchObject({ kind: 'mfa_required', methods: ['totp'] });
    if (first.kind !== 'mfa_required') throw new Error('esperava MFA');
    expect(first.pending.cookies.authentik_session).toBe('sess-1');

    const wrong = await client.verifyCode(first.pending, '000000');
    expect(wrong.kind).toBe('mfa_invalid');
    if (wrong.kind !== 'mfa_invalid') throw new Error('esperava código inválido');

    const right = await client.verifyCode(wrong.pending, '123456');
    expect(right.kind).toBe('authenticated');
    expect(
      idp.calls.filter((call) => call.body?.component === 'ak-stage-authenticator-validate'),
    ).toHaveLength(2);
    expect(idp.sessions.size).toBe(0);
  });

  it('[Falha de integração] MFA só com WebAuthn/Duo: sem código a digitar → indisponível', async () => {
    idp.state.mfaCode = '123456';
    idp.state.deviceClasses = ['webauthn'];
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: { step: 'flow', providerStatus: 200, component: 'ak-stage-authenticator-validate' },
    });
  });

  it('[Falha de integração] IdP fora do ar (rede) ou com 5xx → indisponível com o status', async () => {
    idp.state.down = true;
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: { step: 'flow', providerStatus: null, component: null },
    });
    idp.state.down = false;
    idp.state.status5xx = 503;
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: { step: 'flow', providerStatus: 503, component: null },
    });
  });

  it('[Falha de integração] IdP fora na etapa de código: indisponível, a transação segue', async () => {
    idp.state.mfaCode = '123456';
    const first = await client.authenticate(CREDENTIALS);
    if (first.kind !== 'mfa_required') throw new Error('esperava MFA');
    idp.state.down = true;
    expect(await client.verifyCode(first.pending, '123456')).toMatchObject({
      kind: 'unavailable',
      failure: { step: 'mfa' },
    });
  });

  it('[Falha de integração] consentimento explícito no authorize: erro de configuração, sessão encerrada', async () => {
    idp.state.consent = true;
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: {
        step: 'authorize',
        providerStatus: 302,
        component: '/if/flow/default-provider-authorization-explicit-consent/',
      },
    });
    expect(oidc.completions).toHaveLength(0);
    expect(idp.sessions.size).toBe(0);
  });

  it('[Falha de integração] troca do código recusada: indisponível, e a sessão do IdP é encerrada', async () => {
    oidc.state.fail = 'PROVIDER_UNAVAILABLE';
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: { step: 'token', providerStatus: null, component: 'PROVIDER_UNAVAILABLE' },
    });
    expect(idp.sessions.size).toBe(0);
  });

  it('[Falha de integração] descoberta OIDC fora: indisponível no authorize', async () => {
    vi.mocked(oidc.identity.beginLogin).mockRejectedValueOnce(new Error('descoberta'));
    expect(await client.authenticate(CREDENTIALS)).toMatchObject({
      kind: 'unavailable',
      failure: { step: 'authorize', providerStatus: null },
    });
    expect(idp.sessions.size).toBe(0);
  });

  it('[Falha de integração] etapa que o login nativo não conduz (captcha) → indisponível', async () => {
    idp.fetch.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ component: 'ak-stage-captcha' })),
    );
    expect(await client.authenticate(CREDENTIALS)).toEqual({
      kind: 'unavailable',
      failure: { step: 'flow', providerStatus: 200, component: 'ak-stage-captcha' },
    });
  });

  it('[Falha de integração] executor redireciona para fora dele ou responde 404/sem JSON', async () => {
    idp.fetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil' } })),
    );
    expect(await client.authenticate(CREDENTIALS)).toMatchObject({
      kind: 'unavailable',
      failure: { providerStatus: 302 },
    });
    idp.fetch.mockImplementationOnce(() => Promise.resolve(new Response('x', { status: 404 })));
    expect(await client.authenticate(CREDENTIALS)).toMatchObject({
      failure: { providerStatus: 404 },
    });
    idp.fetch.mockImplementationOnce(() => Promise.resolve(new Response('<html>')));
    expect(await client.authenticate(CREDENTIALS)).toMatchObject({
      failure: { providerStatus: 200, component: null },
    });
    idp.fetch.mockImplementationOnce(() => Promise.resolve(Response.json({ sem: 'component' })));
    expect(await client.authenticate(CREDENTIALS)).toMatchObject({
      failure: { providerStatus: 200, component: null },
    });
  });
});

describe('CookieJar', () => {
  it('guarda, atualiza e apaga cookies (Max-Age=0, Expires no passado, valor vazio)', () => {
    const jar = new CookieJar({ antigo: '1' });
    const headers = new Headers();
    headers.append('set-cookie', 'authentik_session=abc; HttpOnly; Path=/');
    headers.append('set-cookie', 'authentik_csrf=t1; Path=/');
    headers.append('set-cookie', 'antigo=; Path=/');
    headers.append('set-cookie', 'semvalor');
    jar.absorb(new Response(null, { headers }));
    expect(jar.toRecord()).toEqual({ authentik_session: 'abc', authentik_csrf: 't1' });
    expect(jar.header()).toBe('authentik_session=abc; authentik_csrf=t1');

    const removal = new Headers();
    removal.append('set-cookie', 'authentik_session=""; Max-Age=0; Path=/');
    removal.append('set-cookie', 'authentik_csrf=t2; expires=Thu, 01 Jan 1970 00:00:00 GMT');
    jar.absorb(new Response(null, { headers: removal }));
    expect(jar.toRecord()).toEqual({});
  });
});
