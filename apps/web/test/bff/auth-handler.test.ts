import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_TRANSACTION_COOKIE } from '@/bff/auth/login-transaction';
import { handleAuthRequest } from '@/bff/auth-handler';
import { handleCspReport, parseCspReports } from '@/bff/csp-report';
import { captureLogsForTests } from '@/bff/logger';
import { UnconfiguredIdentityProvider, createBffRuntime } from '@/bff/runtime';
import { FAKE_PERSONAS } from '@/bff/session/fake-identity';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { TestRuntime } from '@test/support/bff';
import { APP_ORIGIN, browserRequest, createTestRuntime, signIn } from '@test/support/bff';

/* Rotas de sessão do BFF `/api/auth/*` com o provedor fake (FA-06). */

const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const match = new RegExp(`${name}=([^;,]*)`).exec(setCookie);
  return match?.[1] ?? null;
}

/** Login completo: /login → callback do provedor fake → cookie de sessão. */
async function login(test: TestRuntime, query = '?returnTo=%2Fexemplo&as=ana') {
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
    expect(callback.headers.get('Location')).toBe('/exemplo');
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
    const { callback } = await login(test, '?returnTo=https%3A%2F%2Fevil.com');
    expect(callback.headers.get('Location')).toBe('/exemplo');
    expect(logs.lines.some((line) => line.includes('"auth.return_to_rejected"'))).toBe(true);
  });

  it('pessoa sem vínculo → "sem vínculo" (SCR-111), com sessão sem instituição ativa (FA-02)', async () => {
    const test = createTestRuntime();
    const { callback } = await login(test, '?as=gil');
    expect(callback.headers.get('Location')).toBe('/erro/sem-vinculo');
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

  it('provedor não configurado ou fora do ar → SCR-001 "indisponível" mantendo o returnTo', async () => {
    const test = createTestRuntime({ identity: new UnconfiguredIdentityProvider() });
    const response = await handleAuthRequest(
      browserRequest('/api/auth/login?returnTo=%2Fprocessos'),
      'login',
      test.runtime,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/entrar?motivo=indisponivel&returnTo=%2Fprocessos',
    );
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const runtime = createBffRuntime(test.runtime.config);
    expect(runtime.identity.kind).toBe('fake');
  });
});

describe('GET /api/auth/session', () => {
  it('devolve a visão pública (sem tokens) e renova a ociosidade', async () => {
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
      data: { user: { displayName: string }; activeTenant: { name: string }; readOnly: boolean };
    };
    expect(body.data.user.displayName).toBe('Ana Souza');
    expect(body.data.activeTenant.name).toBe('Prefeitura A');
    expect((await test.store.get(record.key))?.lastSeenAt).toBe(test.clock.now);
  });

  it('keepalive=1 não renova a ociosidade (RN-IAM-21)', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 60_000;
    await handleAuthRequest(
      browserRequest('/api/auth/session?keepalive=1', { headers: { Cookie: cookie } }),
      'session',
      test.runtime,
    );
    expect((await test.store.get(record.key))?.lastSeenAt).toBe(record.lastSeenAt);
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
    expect(expired.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('POST /api/auth/switch-tenant', () => {
  const tenantB = FAKE_PERSONAS.ana.memberships[1].tenant.id;

  it('troca a instituição ativa na mesma sessão', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const response = await handleAuthRequest(
      browserRequest('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantB }),
      }),
      'switch-tenant',
      test.runtime,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { activeTenant: { id: string } } };
    expect(body.data.activeTenant.id).toBe(tenantB);
    expect((await test.store.get(record.key))?.activeTenantId).toBe(tenantB);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(logs.lines.some((line) => line.includes('"auth.tenant_switch"'))).toBe(true);
  });

  it('exige CSRF, sessão, corpo válido e vínculo usável', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const send = (headers: Record<string, string>, body: string) =>
      handleAuthRequest(
        browserRequest('/api/auth/switch-tenant', { method: 'POST', headers, body }),
        'switch-tenant',
        test.runtime,
      );
    const csrf = await send({ Cookie: cookie }, JSON.stringify({ tenantId: tenantB }));
    expect(((await csrf.json()) as { code: string }).code).toBe('CSRF_REJECTED');
    expect((await send(MUTATION, JSON.stringify({ tenantId: tenantB }))).status).toBe(401);
    expect((await send({ ...MUTATION, Cookie: cookie }, 'não-json')).status).toBe(400);
    expect(
      (await send({ ...MUTATION, Cookie: cookie }, JSON.stringify({ tenantId: 'x' }))).status,
    ).toBe(400);
    const forbidden = await send(
      { ...MUTATION, Cookie: cookie },
      JSON.stringify({ tenantId: '0192a000-0000-7000-8000-00000000000c' }),
    );
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('MEMBERSHIP_INACTIVE');
  });

  it('sessão vencida → 401 SESSION_EXPIRED', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    test.clock.now += 31 * 60_000;
    const response = await handleAuthRequest(
      browserRequest('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
        body: JSON.stringify({ tenantId: tenantB }),
      }),
      'switch-tenant',
      test.runtime,
    );
    expect(((await response.json()) as { code: string }).code).toBe('SESSION_EXPIRED');
  });
});

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
    expect(await response.json()).toEqual({ data: { redirectTo: '/entrar?motivo=saiu' } });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(test.store.size).toBe(0);
    const again = await handleAuthRequest(
      browserRequest('/api/auth/logout', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie },
      }),
      'logout',
      test.runtime,
    );
    expect(again.status).toBe(200);
  });

  it('step-up substitui os tokens da sessão existente (amr com MFA)', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const start = await handleAuthRequest(
      browserRequest('/api/auth/step-up?returnTo=%2Fexemplo', { headers: { Cookie: cookie } }),
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
    expect(callback.headers.get('Location')).toBe('/exemplo');
    expect(
      cookieValue(callback.headers.get('Set-Cookie'), test.runtime.config.sessionCookieName),
    ).toBeNull();
    expect((await test.store.get(record.key))?.amr).toEqual(['pwd', 'otp']);
  });

  it('step-up sem sessão vira login completo', async () => {
    const test = createTestRuntime();
    const response = await handleAuthRequest(
      browserRequest('/api/auth/step-up'),
      'step-up',
      test.runtime,
    );
    expect(new URL(response.headers.get('Location') ?? '').searchParams.get('code')).toBe('ana');
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
