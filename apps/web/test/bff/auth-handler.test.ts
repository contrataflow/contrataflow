import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_TRANSACTION_COOKIE } from '@/bff/auth/login-transaction';
import { OidcIdentityProvider } from '@/bff/auth/oidc-provider';
import { handleAuthRequest } from '@/bff/auth-handler';
import { handleCspReport, parseCspReports } from '@/bff/csp-report';
import { captureLogsForTests } from '@/bff/logger';
import { handleProxyRequest } from '@/bff/proxy-handler';
import { UnconfiguredIdentityProvider, createBffRuntime } from '@/bff/runtime';
import {
  IdentityProviderUnavailableError,
  SessionStoreUnavailableError,
} from '@/bff/session/types';
import type { TestRuntime } from '@test/support/bff';
import { APP_ORIGIN, browserRequest, createTestRuntime, signIn } from '@test/support/bff';
import {
  IDP_CLIENT_ID,
  IDP_CLIENT_SECRET,
  IDP_ISSUER,
  IDP_REDIRECT_URI,
  createFakeIdp,
} from '@test/support/fake-idp';
import type { FakeIdp } from '@test/support/fake-idp';

/* Rotas de sessão do BFF `/api/auth/*` com o provedor fake (FA-06). */

const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

/** Cliente OIDC real do BFF contra o Authentik simulado. */
function oidcProvider(idp: FakeIdp): OidcIdentityProvider {
  return new OidcIdentityProvider({
    issuer: IDP_ISSUER,
    clientId: IDP_CLIENT_ID,
    clientSecret: IDP_CLIENT_SECRET,
    scopes: 'openid offline_access',
    redirectUri: IDP_REDIRECT_URI,
    fetch: idp.fetch,
  });
}

function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const match = new RegExp(`${name}=([^;,]*)`).exec(setCookie);
  return match?.[1] ?? null;
}

/** Login completo: /login → callback do provedor fake → cookie de sessão. */
async function login(test: TestRuntime, query = '?returnTo=%2Fprocessos&as=ana') {
  const start = await handleAuthRequest(
    browserRequest(`/api/auth/login${query}`),
    'login',
    test.runtime,
  );
  const transaction = cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE);
  const callbackUrl = new URL(start.headers.get('Location') ?? '');
  const callback = await handleAuthRequest(
    browserRequest(`${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: { Cookie: `${LOGIN_TRANSACTION_COOKIE}=${transaction ?? ''}` },
    }),
    'callback',
    test.runtime,
  );
  const sessionId = cookieValue(
    callback.headers.get('Set-Cookie'),
    test.runtime.config.sessionCookieName,
  );
  return { start, callback, cookie: `${test.runtime.config.sessionCookieName}=${sessionId ?? ''}` };
}

describe('login e callback', () => {
  it('login cria transação (state) e redireciona ao provedor', async () => {
    const test = createTestRuntime();
    const { start } = await login(test);
    expect(start.status).toBe(302);
    expect(start.headers.get('Location')).toMatch(
      /^http:\/\/localhost:3000\/api\/auth\/callback\?code=ana&state=/,
    );
    const setCookie = start.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${LOGIN_TRANSACTION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly; Secure; SameSite=Lax; Max-Age=600');
    expect(start.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('callback cria a sessão com cookie __Host- e volta ao returnTo', async () => {
    const test = createTestRuntime();
    const { callback } = await login(test);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/processos');
    const setCookie = callback.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(
      /__Host-cf_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax/,
    );
    expect(setCookie).toContain(
      `${LOGIN_TRANSACTION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    expect(test.store.size).toBe(1);
    expect(logs.lines.some((line) => line.includes('"auth.session_created"'))).toBe(true);
  });

  it('returnTo externo é recusado (cai no destino padrão) e registrado', async () => {
    const test = createTestRuntime();
    const { callback } = await login(test, '?returnTo=https%3A%2F%2Fevil.com&as=ana');
    expect(callback.headers.get('Location')).toBe('/painel');
    expect(logs.lines.some((line) => line.includes('"auth.return_to_rejected"'))).toBe(true);
  });

  it('pessoa sem vínculo → "sem vínculo" (SCR-111), com sessão sem instituição ativa (FA-02)', async () => {
    const test = createTestRuntime();
    const { callback } = await login(test, '?as=gil');
    expect(callback.headers.get('Location')).toBe('/erro/sem-vinculo');
    expect(test.store.size).toBe(1);
  });

  it('pessoa sem vínculo que veio de um convite → volta ao /convite/<token> para aceitar (US-091)', async () => {
    const test = createTestRuntime();
    const token = 'A'.repeat(43);
    const { callback } = await login(test, `?returnTo=%2Fconvite%2F${token}&as=gil`);
    expect(callback.headers.get('Location')).toBe(`/convite/${token}`);
    expect(test.store.size).toBe(1);
  });

  it('callback sem transação (login CSRF) → /entrar?motivo=erro, sem sessão', async () => {
    const test = createTestRuntime();
    const response = await handleAuthRequest(
      browserRequest('/api/auth/callback?code=ana&state=forjado'),
      'callback',
      test.runtime,
    );
    expect(response.headers.get('Location')).toBe('/entrar?motivo=erro');
    expect(test.store.size).toBe(0);
    expect(logs.lines.some((line) => line.includes('"STATE_MISMATCH"'))).toBe(true);
  });

  it('anti-fixação: novo login gera novo id e encerra a sessão anterior', async () => {
    const test = createTestRuntime();
    const first = await login(test);
    const start = await handleAuthRequest(
      browserRequest('/api/auth/login?as=ana'),
      'login',
      test.runtime,
    );
    const transaction =
      cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    const url = new URL(start.headers.get('Location') ?? '');
    const second = await handleAuthRequest(
      browserRequest(`${url.pathname}${url.search}`, {
        headers: { Cookie: `${first.cookie}; ${LOGIN_TRANSACTION_COOKIE}=${transaction}` },
      }),
      'callback',
      test.runtime,
    );
    const secondId = cookieValue(
      second.headers.get('Set-Cookie'),
      test.runtime.config.sessionCookieName,
    );
    expect(secondId).not.toBe(first.cookie.split('=')[1]);
    expect(test.store.size).toBe(1);
  });

  it('GET /api/auth/login leva à tela nativa /entrar preservando o returnTo (DEC-187)', async () => {
    const test = createTestRuntime({ identity: new UnconfiguredIdentityProvider() });
    const response = await handleAuthRequest(
      browserRequest('/api/auth/login?returnTo=%2Fprocessos%2F1'),
      'login',
      test.runtime,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/entrar?returnTo=%2Fprocessos%2F1');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    // Sem provedor fake, o atalho ?as= não existe: também vai à tela.
    const shortcut = await handleAuthRequest(
      browserRequest('/api/auth/login?as=ana'),
      'login',
      test.runtime,
    );
    expect(shortcut.headers.get('Location')).toBe('/entrar');
    const runtime = createBffRuntime(test.runtime.config);
    expect(runtime.identity.kind).toBe('fake');
  });
});

describe('GET /api/auth/session', () => {
  it('devolve a visão pública (sem tokens) e, como sondagem, não renova a ociosidade', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 60_000;
    const response = await handleAuthRequest(
      browserRequest('/api/auth/session', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(record.tokens.accessToken);
    const body = JSON.parse(text) as {
      data: {
        user: { displayName: string };
        activeTenant: { name: string };
        idleMinutes: number;
        idleExpiresAt: string;
        absoluteExpiresAt: string;
      };
    };
    expect(body.data.user.displayName).toBe('Ana Souza');
    expect(body.data.activeTenant.name).toBe('Prefeitura A');
    expect(body.data.idleMinutes).toBe(30);
    expect(body.data.idleExpiresAt).toBe(new Date(record.idleExpiresAt).toISOString());
    expect(body.data.absoluteExpiresAt).toBe(new Date(record.absoluteExpiresAt).toISOString());
    expect((await test.store.get(record.key))?.lastSeenAt).toBe(record.lastSeenAt);
  });

  it('[Sucesso] FA-01 keepalive=true ("Continuar conectado") renova a ociosidade', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 29 * 60_000;
    const response = await handleAuthRequest(
      browserRequest('/api/auth/session?keepalive=true', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    const body = (await response.json()) as { data: { idleExpiresAt: string } };
    expect(body.data.idleExpiresAt).toBe(new Date(test.clock.now + 30 * 60_000).toISOString());
    expect((await test.store.get(record.key))?.lastSeenAt).toBe(test.clock.now);
  });

  it('[Validação] duração absoluta não é prorrogável: "Continuar conectado" às 19:59', async () => {
    const test = createTestRuntime();
    test.clock.now = Date.parse('2026-10-14T08:00:00-03:00');
    const { cookie, record } = await signIn(test);
    // Uso contínuo até 19:59 (uma ação a cada 20 min).
    while (test.clock.now < Date.parse('2026-10-14T19:59:00-03:00')) {
      test.clock.now = Math.min(
        test.clock.now + 20 * 60_000,
        Date.parse('2026-10-14T19:59:00-03:00'),
      );
      await handleAuthRequest(
        browserRequest('/api/auth/session?keepalive=true', { headers: { Cookie: cookie } }),
        'session',
        test.runtime,
      );
    }
    const extended = (await (
      await handleAuthRequest(
        browserRequest('/api/auth/session?keepalive=true', { headers: { Cookie: cookie } }),
        'session',
        test.runtime,
      )
    ).json()) as { data: { idleExpiresAt: string; absoluteExpiresAt: string } };
    expect(extended.data.idleExpiresAt).toBe('2026-10-14T23:00:00.000Z');
    expect(extended.data.absoluteExpiresAt).toBe('2026-10-14T23:00:00.000Z');
    test.clock.now = Date.parse('2026-10-14T20:00:00-03:00');
    const ended = await handleAuthRequest(
      browserRequest('/api/auth/session?keepalive=true', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect(ended.status).toBe(401);
    expect(((await ended.json()) as { code: string }).code).toBe('SESSION_EXPIRED');
    expect(test.store.endings()).toMatchObject([
      { key: record.key, reason: 'ABSOLUTE', occurredAt: Date.parse('2026-10-14T20:00:00-03:00') },
    ]);
  });

  it('sem sessão → 401; vencida → 401 SESSION_EXPIRED com cookie apagado', async () => {
    const test = createTestRuntime();
    const none = await handleAuthRequest(
      browserRequest('/api/auth/session'),
      'session',
      test.runtime,
    );
    expect(none.status).toBe(401);
    const { cookie } = await signIn(test);
    test.clock.now += 13 * 60 * 60_000;
    const expired = await handleAuthRequest(
      browserRequest('/api/auth/session', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect(((await expired.json()) as { code: string }).code).toBe('SESSION_EXPIRED');
    const setCookie = expired.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(
      '__Host-cf_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
    // Marca de reautenticação: a próxima entrada pede a senha de novo (RN-IAM-32).
    expect(setCookie).toContain('__Host-cf_reauth=1; Path=/; HttpOnly; Secure; SameSite=Lax');
    // Outra aba com o mesmo cookie: continua "expirada" (modal), não "sem sessão".
    const again = await handleAuthRequest(
      browserRequest('/api/auth/session', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect(((await again.json()) as { code: string }).code).toBe('SESSION_EXPIRED');
  });

  it('[Tenant incorreto] sessão encerrada pelo vínculo → 403 MEMBERSHIP_INACTIVE (FA-08)', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    await test.store.end(record, {
      reason: 'MEMBERSHIP_SUSPENDED',
      occurredAt: test.clock.now,
      ip: null,
      userAgent: null,
    });
    const response = await handleAuthRequest(
      browserRequest('/api/auth/session', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('MEMBERSHIP_INACTIVE');
  });
});

describe('login após expiração (RN-IAM-32)', () => {
  it('GET /api/auth/login após expiração (reauth=1 ou a marca do BFF) leva a /entrar com o aviso', async () => {
    const test = createTestRuntime();
    const byQuery = await handleAuthRequest(
      browserRequest('/api/auth/login?returnTo=%2Fprocessos&reauth=1'),
      'login',
      test.runtime,
    );
    expect(byQuery.headers.get('Location')).toBe(
      '/entrar?motivo=sessao-expirada&returnTo=%2Fprocessos',
    );
    const byMark = await handleAuthRequest(
      browserRequest('/api/auth/login', { headers: { Cookie: '__Host-cf_reauth=1' } }),
      'login',
      test.runtime,
    );
    expect(byMark.headers.get('Location')).toBe('/entrar?motivo=sessao-expirada');
    // O callback do atalho de desenvolvimento apaga a marca.
    const start = await handleAuthRequest(
      browserRequest('/api/auth/login?as=ana'),
      'login',
      test.runtime,
    );
    const transaction = cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE);
    const callbackUrl = new URL(start.headers.get('Location') ?? '');
    const callback = await handleAuthRequest(
      browserRequest(`${callbackUrl.pathname}${callbackUrl.search}`, {
        headers: {
          Cookie: `${LOGIN_TRANSACTION_COOKIE}=${transaction ?? ''}; __Host-cf_reauth=1`,
        },
      }),
      'callback',
      test.runtime,
    );
    expect(callback.headers.get('Set-Cookie')).toContain('__Host-cf_reauth=; Path=/');
  });
});

// Troca de instituição (US-093): `test/bff/tenant-switch.test.ts`.

describe('POST /api/auth/logout e GET /api/auth/step-up', () => {
  it('logout por POST com CSRF destrói a sessão e apaga o cookie', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const rejected = await handleAuthRequest(
      browserRequest('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }),
      'logout',
      test.runtime,
    );
    expect(rejected.status).toBe(403);
    expect(test.store.size).toBe(1);

    const response = await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
      }),
      'logout',
      test.runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { logoutUrl: '/entrar?motivo=saiu' } });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(test.store.size).toBe(0);
    // [Duplicidade] Logout repetido: 200 e um único registro de encerramento.
    const again = await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
      }),
      'logout',
      test.runtime,
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ data: { logoutUrl: '/entrar?motivo=saiu' } });
    expect(test.store.endings().map((ending) => ending.reason)).toEqual(['LOGOUT']);
    const logouts = logs.lines.filter((line) => line.includes('"event":"auth.logout"'));
    expect(logouts).toHaveLength(1);
  });

  it('[Sucesso] logout com Authentik: revoga o refresh token e volta à SCR-001 sem passar pelo IdP', async () => {
    const idp = await createFakeIdp(() => Date.now());
    const test = createTestRuntime({ identity: oidcProvider(idp) });
    const { cookie, record } = await signIn(test);
    const response = await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: {
          ...MUTATION,
          Cookie: cookie,
          'User-Agent': 'Firefox',
          'X-Forwarded-For': '200.1.2.3',
        },
      }),
      'logout',
      test.runtime,
    );
    // Sem end-session (DEC-187): o navegador nunca é levado ao IdP no logout.
    expect(await response.json()).toEqual({ data: { logoutUrl: '/entrar?motivo=saiu' } });
    expect(Object.fromEntries(idp.revocations[0]?.form ?? [])).toMatchObject({
      token: record.tokens.refreshToken,
    });
    expect(test.store.endings()).toMatchObject([
      { key: record.key, reason: 'LOGOUT', userAgent: 'Firefox', ip: '200.1.2.3' },
    ]);
    const line = logs.lines.find((entry) => entry.includes('"event":"auth.logout"')) ?? '';
    expect(JSON.parse(line)).toMatchObject({ revocation: 'revoked', userId: record.userId });
    // Nunca logar sid, tokens ou cookie.
    const all = logs.lines.join('\n');
    expect(all).not.toContain(cookie.split('=')[1]);
    expect(all).not.toContain(record.tokens.refreshToken ?? 'x');
    expect(all).not.toContain(record.key);
  });

  it('[Falha de integração] FA-06 Authentik fora do ar: o logout local se conclui e volta à SCR-001', async () => {
    const idp = await createFakeIdp(() => Date.now());
    idp.state.down = true;
    const test = createTestRuntime({ identity: oidcProvider(idp) });
    const { cookie } = await signIn(test);
    const response = await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
      }),
      'logout',
      test.runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { logoutUrl: '/entrar?motivo=saiu' } });
    expect(test.store.size).toBe(0);
    expect(logs.lines.some((line) => line.includes('auth.revocation_unavailable'))).toBe(true);
  });

  it('[Concorrência] logout na aba A durante comando na aba B → B recebe 401', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    // A aba B leu a sessão (e vai gravar o último uso) quando a aba A sai.
    await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
      }),
      'logout',
      test.runtime,
    );
    await test.runtime.sessions.touch(record);
    expect(await test.store.get(record.key)).toBeNull();
    const command = await handleProxyRequest(
      browserRequest('/api/v1/processes', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      ['processes'],
      test.runtime,
    );
    expect(command.status).toBe(401);
    expect(((await command.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(test.api).not.toHaveBeenCalled();
  });

  it('step-up substitui os tokens da sessão existente (amr com MFA)', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const start = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fprocessos', { headers: { Cookie: cookie } }),
      'step-up',
      test.runtime,
    );
    const url = new URL(start.headers.get('Location') ?? '');
    expect(url.searchParams.get('code')).toBe('ana:mfa');
    const transaction =
      cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    const callback = await handleAuthRequest(
      browserRequest(`${url.pathname}${url.search}`, {
        headers: { Cookie: `${cookie}; ${LOGIN_TRANSACTION_COOKIE}=${transaction}` },
      }),
      'callback',
      test.runtime,
    );
    expect(callback.headers.get('Location')).toBe('/processos');
    expect(
      cookieValue(callback.headers.get('Set-Cookie'), test.runtime.config.sessionCookieName),
    ).toBeNull();
    expect((await test.store.get(record.key))?.amr).toEqual(['pwd', 'otp']);
  });

  it('[Sucesso · US-090] step-up concluído registra auth.step_up_completed sem o fator usado', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const start = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fadmin%2Fusuarios', {
        headers: { Cookie: cookie },
      }),
      'step-up',
      test.runtime,
    );
    const url = new URL(start.headers.get('Location') ?? '');
    const transaction =
      cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    await handleAuthRequest(
      browserRequest(`${url.pathname}${url.search}`, {
        headers: { Cookie: `${cookie}; ${LOGIN_TRANSACTION_COOKIE}=${transaction}` },
      }),
      'callback',
      test.runtime,
    );
    const completed = logs.lines.filter((line) =>
      line.includes('"event":"auth.step_up_completed"'),
    );
    expect(completed).toHaveLength(1);
    const entry = JSON.parse(completed[0] ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({ userId: record.userId });
    expect(typeof entry.durationMs).toBe('number');
    expect(completed[0]).not.toMatch(/otp|accessToken|refresh/);
  });

  it('[Falha de integração · US-090] Authentik fora no step-up: SCR-111 com nova tentativa e a sessão intacta', async () => {
    const base = createTestRuntime();
    const identity = base.runtime.identity;
    const test = createTestRuntime({
      identity: {
        kind: identity.kind,
        beginLogin: (input) =>
          input.stepUp
            ? Promise.reject(new IdentityProviderUnavailableError())
            : identity.beginLogin(input),
        completeLogin: (params, secrets) => identity.completeLogin(params, secrets),
        refresh: (record) => identity.refresh(record),
        revokeRefreshToken: (record) => identity.revokeRefreshToken(record),
      },
    });
    const { cookie, record } = await signIn(test);
    const response = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fadmin%2Fperfis', {
        headers: { Cookie: cookie },
      }),
      'step-up',
      test.runtime,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '', APP_ORIGIN);
    // Nunca `/entrar`: com a sessão ativa, voltaria ao destino e à mesma recusa (laço).
    expect(location.pathname).toBe('/erro/confirmacao-indisponivel');
    expect(location.searchParams.get('retorno')).toBe('/admin/perfis');
    expect(location.searchParams.get('codigo')).not.toBeNull();
    expect(await test.store.get(record.key)).toMatchObject({ amr: record.amr });
    expect(logs.lines.some((line) => line.includes('"event":"auth.step_up_unavailable"'))).toBe(
      true,
    );
  });

  it('[FA-04 · US-090] desafio cancelado: a sessão não muda e a pessoa pode tentar de novo', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const start = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fadmin%2Fperfis', {
        headers: { Cookie: cookie },
      }),
      'step-up',
      test.runtime,
    );
    const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state') ?? '';
    const transaction =
      cookieValue(start.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    const callback = await handleAuthRequest(
      browserRequest(
        `/api/auth/callback?${new URLSearchParams({ error: 'access_denied', state }).toString()}`,
        { headers: { Cookie: `${cookie}; ${LOGIN_TRANSACTION_COOKIE}=${transaction}` } },
      ),
      'callback',
      test.runtime,
    );
    const location = new URL(callback.headers.get('Location') ?? '', APP_ORIGIN);
    expect(location.pathname).toBe('/erro/confirmacao-nao-concluida');
    expect(location.searchParams.get('retorno')).toBe('/admin/perfis');
    const kept = await test.store.get(record.key);
    expect(kept?.amr).toEqual(record.amr);
    expect(kept?.tokens.accessToken).toBe(record.tokens.accessToken);
  });

  it('step-up sem sessão vira login completo, na tela nativa e com o destino', async () => {
    const test = createTestRuntime();
    const response = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fadmin%2Fperfis'),
      'step-up',
      test.runtime,
    );
    expect(response.headers.get('Location')).toBe('/entrar?returnTo=%2Fadmin%2Fperfis');
  });
});

describe('roteamento das ações', () => {
  it('ação desconhecida → 404; método errado → 405 com Allow', async () => {
    const test = createTestRuntime();
    const unknown = await handleAuthRequest(browserRequest('/api/auth/x'), 'x', test.runtime);
    expect(unknown.status).toBe(404);
    const wrong = await handleAuthRequest(
      browserRequest('/api/auth/logout'),
      'logout',
      test.runtime,
    );
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('POST');
    expect(wrong.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('Redis de sessões fora do ar → 503 DEPENDENCY_UNAVAILABLE com Retry-After (nunca 401)', async () => {
    const test = createTestRuntime();
    const broken = {
      ...test.runtime,
      sessions: { lookup: () => Promise.reject(new SessionStoreUnavailableError()) },
    } as unknown as TestRuntime['runtime'];
    const response = await handleAuthRequest(
      browserRequest('/api/auth/session'),
      'session',
      broken,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(((await response.json()) as { code: string }).code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('exceção inesperada → 500 e log', async () => {
    const test = createTestRuntime();
    const broken = {
      ...test.runtime,
      sessions: { lookup: () => Promise.reject(new Error('redis fora')) },
    } as unknown as TestRuntime['runtime'];
    const response = await handleAuthRequest(
      browserRequest('/api/auth/session'),
      'session',
      broken,
    );
    expect(response.status).toBe(500);
    expect(logs.lines.some((line) => line.includes('"bff.unhandled_exception"'))).toBe(true);
  });
});

describe('relatório de CSP', () => {
  it('registra só diretiva e origem bloqueada', async () => {
    const response = await handleCspReport(
      new Request(`${APP_ORIGIN}/api/csp-report`, {
        method: 'POST',
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://app/processos?cpf=12345678900',
            'effective-directive': 'script-src-elem',
            'blocked-uri': 'https://evil.example/x.js?token=abc',
          },
        }),
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const line = logs.lines.find((entry) => entry.includes('"bff.csp_violation"')) ?? '';
    expect(JSON.parse(line)).toMatchObject({
      directive: 'script-src-elem',
      blockedOrigin: 'https://evil.example',
    });
    expect(line).not.toContain('cpf');
    expect(line).not.toContain('token');
  });

  it('Reporting API, palavras-chave e entradas inválidas', () => {
    expect(
      parseCspReports([
        { body: { effectiveDirective: 'script-src', blockedURL: 'inline' } },
        { body: { effectiveDirective: 'X Y', blockedURL: 42 } },
        'lixo',
        { semCorpo: true },
      ]),
    ).toEqual([
      { directive: 'script-src', blockedOrigin: 'inline' },
      { directive: 'unknown', blockedOrigin: 'unknown' },
    ]);
  });

  it('corpo inválido → 400; grande demais → 413', async () => {
    const invalid = await handleCspReport(
      new Request(`${APP_ORIGIN}/api/csp-report`, { method: 'POST', body: '{' }),
    );
    expect(invalid.status).toBe(400);
    const large = await handleCspReport(
      new Request(`${APP_ORIGIN}/api/csp-report`, { method: 'POST', body: 'x'.repeat(20_000) }),
    );
    expect(large.status).toBe(413);
    const empty = await handleCspReport(
      new Request(`${APP_ORIGIN}/api/csp-report`, { method: 'POST' }),
    );
    expect(empty.status).toBe(204);
  });
});
