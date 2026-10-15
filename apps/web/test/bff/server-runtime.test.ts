import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as authGet, POST as authPost } from '@/app/api/auth/[action]/route';
import { POST as cspPost } from '@/app/api/csp-report/route';
import { GET as proxyGet } from '@/app/api/v1/[...path]/route';
import { captureLogsForTests, log } from '@/bff/logger';
import { UnconfiguredIdentityProvider, bffRuntime, setBffRuntimeForTests } from '@/bff/runtime';
import {
  apiServerClient,
  currentNonce,
  currentPathname,
  currentShellSession,
} from '@/bff/server-session';
import { resetWebConfigForTests } from '@/config/env';
import { proxy } from '@/proxy';
import { APP_ORIGIN, BASE_ENV, createTestRuntime, signIn } from '@test/support/bff';

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = request.cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
  headers: () => Promise.resolve(request.headers),
}));

beforeEach(() => {
  request.cookies.clear();
  request.headers = new Headers();
});

afterEach(() => {
  setBffRuntimeForTests(undefined);
  resetWebConfigForTests();
  vi.unstubAllEnvs();
});

/** `nome=valor` do cabeçalho Cookie para o `cookies()` simulado. */
function setCookie(cookie: string): void {
  const separator = cookie.indexOf('=');
  request.cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
}

async function activeSession() {
  const test = createTestRuntime();
  const { cookie, record } = await signIn(test);
  setCookie(cookie);
  return { test, record };
}

describe('apiServerClient (Server Components — RN-FND-88)', () => {
  it('lê com a sessão do cookie e devolve { data, meta }', async () => {
    const { test, record } = await activeSession();
    request.headers = new Headers({
      'X-Correlation-Id': 'c-rsc-0001',
      'X-Forwarded-For': '200.1.2.3',
      'User-Agent': 'Navegador/1.0',
    });
    test.api.mockResolvedValueOnce(
      Response.json({ data: { ok: 1 }, meta: { page: 1 } }, { headers: { ETag: '"2"' } }),
    );
    const result = await apiServerClient.get<{ ok: number }>(
      '/processes',
      { query: { page: 1, status: undefined } },
      test.runtime,
    );
    expect(result).toEqual({
      data: { ok: 1 },
      status: 200,
      meta: { page: 1, etag: '"2"', correlationId: 'c-rsc-0001', replayed: false },
    });
    const [url, init] = test.api.mock.calls[0] ?? [];
    expect(url).toBe('http://api.internal:4000/api/v1/processes?page=1');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${record.tokens.accessToken}`);
    expect(headers.get('X-Tenant-Id')).toBe(record.activeTenantId);
    expect(headers.get('X-Forwarded-For')).toBe('200.1.2.3');
    expect(headers.get('User-Agent')).toBe('Navegador/1.0');
    expect(headers.get('X-CF-Session-Id-Hash')).toBe(record.key);
  });

  it('erros viram ApiError (problem+json, rede, sessão)', async () => {
    const { test } = await activeSession();
    test.api.mockResolvedValueOnce(new Response('{"code":"NOT_FOUND"}', { status: 404 }));
    await expect(apiServerClient.get('/x', {}, test.runtime)).rejects.toMatchObject({
      status: 404,
    });
    test.api.mockResolvedValueOnce(new Response('não-json', { status: 500 }));
    await expect(apiServerClient.get('/x', {}, test.runtime)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    test.api.mockRejectedValueOnce(new TypeError('offline'));
    await expect(apiServerClient.get('/x', {}, test.runtime)).rejects.toMatchObject({
      status: 503,
    });
    test.api.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(apiServerClient.get('/x', {}, test.runtime)).resolves.toMatchObject({
      data: undefined,
    });

    request.cookies.clear();
    await expect(apiServerClient.get('/x', {}, test.runtime)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('sessão vencida → SESSION_EXPIRED; IdP fora sem token → 503', async () => {
    const { test } = await activeSession();
    test.clock.now += 31 * 60_000;
    await expect(apiServerClient.get('/x', {}, test.runtime)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    const base = createTestRuntime();
    const identity = {
      kind: 'oidc' as const,
      beginLogin: base.runtime.identity.beginLogin.bind(base.runtime.identity),
      completeLogin: base.runtime.identity.completeLogin.bind(base.runtime.identity),
      refresh: () => Promise.resolve({ kind: 'invalid_grant' as const }),
      endSessionUrl: () => null,
    };
    const expiring = createTestRuntime({ identity });
    const { cookie, record } = await signIn(expiring);
    setCookie(cookie);
    expiring.clock.now = record.tokens.accessTokenExpiresAt;
    await expect(apiServerClient.get('/x', {}, expiring.runtime)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    const unavailable = createTestRuntime({ identity: new UnconfiguredIdentityProvider() });
    const second = await signIn(unavailable);
    setCookie(second.cookie);
    unavailable.clock.now = second.record.tokens.accessTokenExpiresAt + 1;
    await expect(apiServerClient.get('/x', {}, unavailable.runtime)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('visão da sessão, caminho e nonce da requisição', async () => {
    const { test } = await activeSession();
    request.headers = new Headers({ 'x-cf-pathname': '/processos?page=2', 'x-nonce': 'n-1' });
    expect(await currentPathname()).toBe('/processos?page=2');
    expect(await currentNonce()).toBe('n-1');
    expect((await currentShellSession(test.runtime))?.user.displayName).toBe('Ana Souza');
    request.cookies.clear();
    request.headers = new Headers();
    expect(await currentPathname()).toBe('/');
    expect(await currentNonce()).toBeUndefined();
    expect(await currentShellSession(test.runtime)).toBeNull();
  });
});

describe('runtime do processo', () => {
  it('monta o runtime a partir de process.env (memoizado) e aceita injeção', () => {
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    const runtime = bffRuntime();
    expect(bffRuntime()).toBe(runtime);
    expect(runtime.identity.kind).toBe('fake');
    expect(runtime.upstreamTimeoutMs).toBe(30_000);
    const injected = createTestRuntime().runtime;
    setBffRuntimeForTests(injected);
    expect(bffRuntime()).toBe(injected);
  });

  it('sem chave fake e sem OIDC: provedor não configurado', async () => {
    for (const [key, value] of Object.entries({ ...BASE_ENV, OIDC_FAKE_SIGNING_KEY: '' }))
      vi.stubEnv(key, value);
    vi.stubEnv('OIDC_FAKE_SIGNING_KEY', undefined);
    const runtime = bffRuntime();
    expect(runtime.identity).toBeInstanceOf(UnconfiguredIdentityProvider);
    await expect(
      runtime.identity.beginLogin({ appOrigin: '', stepUp: false, hint: null }),
    ).rejects.toThrow();
    expect(
      await runtime.identity.completeLogin(new URLSearchParams(), {
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
      }),
    ).toEqual({ ok: false, reason: 'PROVIDER_UNAVAILABLE' });
    expect(runtime.identity.endSessionUrl(null)).toBeNull();
  });

  it('fetch padrão delega ao fetch global', async () => {
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    const global = vi.fn(() => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', global);
    await bffRuntime().fetch('http://x');
    expect(global).toHaveBeenCalledWith('http://x', undefined);
    vi.unstubAllGlobals();
  });

  it('logger escreve JSON por linha no stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    log('info', 'auth.session_end', { reason: 'LOGOUT' });
    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      service: 'web',
      event: 'auth.session_end',
      reason: 'LOGOUT',
    });
    write.mockRestore();
  });
});

describe('route handlers e proxy.ts', () => {
  it('delegam ao BFF', async () => {
    const test = createTestRuntime();
    setBffRuntimeForTests(test.runtime);
    const logs = captureLogsForTests();
    const { cookie } = await signIn(test);
    const session = await authGet(
      new Request(`${APP_ORIGIN}/api/auth/session`, { headers: { Cookie: cookie } }),
      {
        params: Promise.resolve({ action: 'session' }),
      },
    );
    expect(session.status).toBe(200);
    const logout = await authPost(
      new Request(`${APP_ORIGIN}/api/auth/logout`, { method: 'POST' }),
      {
        params: Promise.resolve({ action: 'logout' }),
      },
    );
    expect(logout.status).toBe(403);
    const proxied = await proxyGet(new Request(`${APP_ORIGIN}/api/v1/me`), {
      params: Promise.resolve({ path: ['me'] }),
    });
    expect(proxied.status).toBe(401);
    const csp = await cspPost(new Request(`${APP_ORIGIN}/api/csp-report`, { method: 'POST' }));
    expect(csp.status).toBe(204);
    logs.restore();
  });

  it('proxy.ts aplica nonce e cabeçalhos de segurança', async () => {
    const { NextRequest } = await import('next/server');
    const response = proxy(new NextRequest(`${APP_ORIGIN}/exemplo?x=1`));
    expect(response.headers.get('Content-Security-Policy')).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
