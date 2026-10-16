import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureLogsForTests } from '@/bff/logger';
import { handleProxyRequest, proxyPath, readLimitedBody } from '@/bff/proxy-handler';
import type { IdentityProvider, RefreshResult } from '@/bff/session/types';
import { MAX_BODY_BYTES, isAllowedOutboundHeader, routeTemplate } from '@/bff/upstream';
import type { TestRuntime } from '@test/support/bff';
import { API_URL, browserRequest, createTestRuntime, lastApiCall, signIn } from '@test/support/bff';

/*
 * Integração do proxy `/api/v1/[...path]` com a API simulada (RN-FND-89): allowlist de
 * cabeçalhos, CSRF, timeout, corpo ≤ 2 MB, remoção de Cookie/Authorization e SESSION_EXPIRED.
 */

const MUTATION_HEADERS = {
  'Content-Type': 'application/json',
  'X-CF-Request': '1',
  'Sec-Fetch-Site': 'same-origin',
};

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

async function problemCode(response: Response): Promise<string> {
  const body = (await response.json()) as { code: string };
  return body.code;
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('Strict-Transport-Security')).toBe(
    'max-age=63072000; includeSubDomains; preload',
  );
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('X-Correlation-Id')).toBeTruthy();
}

function refreshing(result: () => RefreshResult, base: TestRuntime): IdentityProvider {
  const identity = base.runtime.identity;
  return {
    kind: identity.kind,
    beginLogin: (input) => identity.beginLogin(input),
    completeLogin: (params, transaction) => identity.completeLogin(params, transaction),
    refresh: () => Promise.resolve(result()),
    revokeRefreshToken: () => Promise.resolve('skipped' as const),
    endSessionUrl: () => Promise.resolve(null),
  };
}

describe('[Sucesso] proxy autenticado', () => {
  it('injeta Authorization/X-Tenant-Id/X-Correlation-Id e remove o que vem do browser', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const response = await handleProxyRequest(
      browserRequest('/api/v1/_internal/items?page=2&pageSize=10', {
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer forjado',
          'X-Tenant-Id': 'tenant-forjado',
          'X-Forwarded-For': '9.9.9.9, 200.1.2.3',
          'X-Correlation-Id': 'c-browser-1',
          'X-CF-Session-Id-Hash': 'forjado',
          'User-Agent': 'Navegador/1.0',
          'X-Custom': 'nao-repassar',
          Accept: 'application/json',
          'If-Match': '"3"',
        },
      }),
      ['_internal', 'items'],
      test.runtime,
    );
    expect(response.status).toBe(200);
    const { url, init } = lastApiCall(test.api);
    expect(url).toBe(`${API_URL}/api/v1/_internal/items?page=2&pageSize=10`);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${record.tokens.accessToken}`);
    expect(headers.get('X-Tenant-Id')).toBe(record.activeTenantId);
    expect(headers.get('X-Correlation-Id')).toBe('c-browser-1');
    expect(headers.get('X-Forwarded-For')).toBe('200.1.2.3');
    // Auditoria da API (US-073): user-agent do navegador e a sessão do registro, nunca o forjado.
    expect(headers.get('User-Agent')).toBe('Navegador/1.0');
    expect(headers.get('X-CF-Session-Id-Hash')).toBe(record.key);
    expect(headers.get('If-Match')).toBe('"3"');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('X-Custom')).toBeNull();
    expect(init.redirect).toBe('manual');
    expectSecurityHeaders(response);
  });

  it('repassa só a allowlist de saída e reescreve Location interna', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    test.api.mockResolvedValueOnce(
      new Response('{"data":{}}', {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          ETag: '"4"',
          Location: `${API_URL}/api/v1/processes/1`,
          'Idempotent-Replayed': 'true',
          'RateLimit-Remaining': '9',
          'Retry-After': '3',
          'Set-Cookie': 'api=1',
          Server: 'nest',
          'X-Powered-By': 'Express',
        },
      }),
    );
    const response = await handleProxyRequest(
      browserRequest('/api/v1/processes', {
        method: 'POST',
        headers: { ...MUTATION_HEADERS, Cookie: cookie, 'Idempotency-Key': 'k-1' },
        body: '{"title":"x"}',
      }),
      ['processes'],
      test.runtime,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('"4"');
    expect(response.headers.get('Location')).toBe('/api/v1/processes/1');
    expect(response.headers.get('Idempotent-Replayed')).toBe('true');
    expect(response.headers.get('RateLimit-Remaining')).toBe('9');
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Server')).toBeNull();
    expect(response.headers.get('X-Powered-By')).toBeNull();
    const { init } = lastApiCall(test.api);
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('k-1');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"title":"x"}');
    expect(await response.text()).toBe('{"data":{}}');
  });

  it('registra a requisição sem token, cookie ou corpo', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    await handleProxyRequest(
      browserRequest(`/api/v1/processes/${record.userId}`, { headers: { Cookie: cookie } }),
      ['processes', record.userId],
      test.runtime,
    );
    const line = JSON.parse(logs.lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'bff.proxy_request_completed',
      route: '/processes/:id',
      status: 200,
    });
    const all = logs.lines.join('\n');
    expect(all).not.toContain(record.tokens.accessToken);
    expect(all).not.toContain(cookie.split('=')[1]);
  });
});

describe('nome exibido da sessão após PATCH /me (US-098 · RN-IAM-110)', () => {
  const patchMe = (cookie: string) =>
    browserRequest('/api/v1/me', {
      method: 'PATCH',
      headers: { ...MUTATION_HEADERS, Cookie: cookie, 'If-Match': '"1"' },
      body: JSON.stringify({ socialName: 'Eli' }),
    });
  const profileBody = (socialName: string | null) =>
    JSON.stringify({ data: { name: 'Ana Souza', socialName, version: 2 } });

  it('passa a exibir o nome social, e o corpo chega intacto ao navegador', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.api.mockResolvedValueOnce(
      new Response(profileBody('Eli'), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"2"' },
      }),
    );
    const response = await handleProxyRequest(patchMe(cookie), ['me'], test.runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"2"');
    expect(await response.json()).toEqual({
      data: { name: 'Ana Souza', socialName: 'Eli', version: 2 },
    });
    expect((await test.store.get(record.key))?.displayName).toBe('Eli');
  });

  it('nome social removido volta a exibir o nome civil', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    await test.runtime.sessions.setDisplayName(record, 'Eli');
    test.api.mockResolvedValueOnce(
      new Response(profileBody(null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await handleProxyRequest(patchMe(cookie), ['me'], test.runtime);
    expect((await test.store.get(record.key))?.displayName).toBe('Ana Souza');
  });

  it('falha da API (412) ou outra rota não alteram o nome da sessão', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const before = (await test.store.get(record.key))?.displayName;
    test.api.mockResolvedValueOnce(
      new Response('{"code":"VERSION_CONFLICT"}', {
        status: 412,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );
    expect((await handleProxyRequest(patchMe(cookie), ['me'], test.runtime)).status).toBe(412);
    test.api.mockResolvedValueOnce(
      new Response(profileBody('Outro'), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect((await test.store.get(record.key))?.displayName).toBe(before);
  });

  it('corpo ilegível não derruba a resposta já aplicada pela API', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    const before = (await test.store.get(record.key))?.displayName;
    test.api.mockResolvedValueOnce(
      new Response('não é json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const response = await handleProxyRequest(patchMe(cookie), ['me'], test.runtime);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('não é json');
    expect((await test.store.get(record.key))?.displayName).toBe(before);
    expect(logs.lines.some((line) => line.includes('bff.display_name_sync_failed'))).toBe(true);
  });
});

describe('[Validação] CSRF, caminho e corpo', () => {
  it('V-01: mutação sem X-CF-Request é barrada antes da API', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const response = await handleProxyRequest(
      browserRequest('/api/v1/processes', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: '{}',
      }),
      ['processes'],
      test.runtime,
    );
    expect(response.status).toBe(403);
    expect(await problemCode(response)).toBe('CSRF_REJECTED');
    expect(test.api).not.toHaveBeenCalled();
    expect(logs.lines.some((line) => line.includes('"bff.csrf_rejected"'))).toBe(true);
    expectSecurityHeaders(response);
  });

  it('V-02: origem cruzada é barrada', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const response = await handleProxyRequest(
      browserRequest('/api/v1/processes/1', {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CF-Request': '1', Origin: 'https://evil.example' },
      }),
      ['processes', '1'],
      test.runtime,
    );
    expect(response.status).toBe(403);
    expect(test.api).not.toHaveBeenCalled();
  });

  it('corpo acima de 2 MB → 413 sem chamar a API', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const response = await handleProxyRequest(
      browserRequest('/api/v1/attachments', {
        method: 'POST',
        headers: { ...MUTATION_HEADERS, Cookie: cookie },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
      ['attachments'],
      test.runtime,
    );
    expect(response.status).toBe(413);
    expect(test.api).not.toHaveBeenCalled();
  });

  it('limite também sem Content-Length (streaming)', async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request('http://x/api', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await readLimitedBody(request, 10)).toEqual({ kind: 'too_large' });
    const small = new Request('http://x/api', { method: 'POST', body: 'abc' });
    const read = await readLimitedBody(small, 10);
    expect(read.kind === 'ok' && new TextDecoder().decode(read.body ?? new ArrayBuffer(0))).toBe(
      'abc',
    );
  });

  it.each([[[]], [['..', 'admin']], [['a b']], [['.']]])(
    'caminho inválido %j → 404',
    async (segments) => {
      const test = createTestRuntime();
      const response = await handleProxyRequest(
        browserRequest('/api/v1/x'),
        segments,
        test.runtime,
      );
      expect(response.status).toBe(404);
      expect(test.api).not.toHaveBeenCalled();
    },
  );

  it('proxyPath codifica segmentos válidos', () => {
    expect(proxyPath(['processes', '0192', 'available-actions'])).toBe(
      '/processes/0192/available-actions',
    );
    expect(routeTemplate('/processes/0192a000-0000-7000-8000-00000000000a/items/12')).toBe(
      '/processes/:id/items/:id',
    );
    expect(isAllowedOutboundHeader('RateLimit-Reset')).toBe(true);
    expect(isAllowedOutboundHeader('Set-Cookie')).toBe(false);
  });
});

describe('sessão no proxy', () => {
  it('sem sessão → 401 UNAUTHENTICATED', async () => {
    const test = createTestRuntime();
    const response = await handleProxyRequest(browserRequest('/api/v1/me'), ['me'], test.runtime);
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe('UNAUTHENTICATED');
    expect(test.api).not.toHaveBeenCalled();
  });

  it('sessão ociosa vencida → 401 SESSION_EXPIRED e cookie apagado', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    test.clock.now += 31 * 60_000;
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('requisição do usuário renova a ociosidade', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 10 * 60_000;
    await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    const stored = await test.store.get(record.key);
    expect(stored?.idleExpiresAt).toBe(test.clock.now + 30 * 60_000);
  });

  it('token perto do vencimento é renovado antes da chamada', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now = record.tokens.accessTokenExpiresAt - 30_000;
    await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    const sent = new Headers(lastApiCall(test.api).init.headers).get('Authorization');
    expect(sent).not.toBe(`Bearer ${record.tokens.accessToken}`);
  });

  it('IdP indisponível e token vencido → 503 com sessão preservada', async () => {
    const base = createTestRuntime();
    const test = createTestRuntime({ identity: refreshing(() => ({ kind: 'transient' }), base) });
    const { cookie, record } = await signIn(test);
    test.clock.now = record.tokens.accessTokenExpiresAt + 1;
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(503);
    expect(await problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(test.store.size).toBe(1);
  });
});

describe('[Falha de integração] 401 da API e renovação', () => {
  it('401 → renova e repete com o novo token', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 1000; // o token renovado tem outro `iat`/`exp`
    test.api.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(200);
    expect(test.api).toHaveBeenCalledTimes(2);
    expect(new Headers(lastApiCall(test.api).init.headers).get('Authorization')).not.toBe(
      `Bearer ${record.tokens.accessToken}`,
    );
  });

  it('401 e renovação malsucedida → sessão destruída e 401 SESSION_EXPIRED', async () => {
    const base = createTestRuntime();
    const test = createTestRuntime({
      identity: refreshing(() => ({ kind: 'invalid_grant' }), base),
    });
    const { cookie } = await signIn(test);
    test.api.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(test.store.size).toBe(0);
    expect(logs.lines.some((line) => line.includes('"bff.session_refresh_failed"'))).toBe(true);
  });

  it('401 de novo após renovar → sessão destruída', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    test.api.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(test.store.size).toBe(0);
  });

  it('401 com IdP indisponível → 503, sessão preservada', async () => {
    const base = createTestRuntime();
    const test = createTestRuntime({ identity: refreshing(() => ({ kind: 'transient' }), base) });
    const { cookie } = await signIn(test);
    test.api.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(503);
    expect(test.store.size).toBe(1);
  });
});

describe('[Falha de banco] indisponibilidade da API', () => {
  it('timeout (30 s em produção) → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const test = createTestRuntime({ upstreamTimeoutMs: 20 });
    const { cookie } = await signIn(test);
    test.api.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'TimeoutError'));
          });
        }),
    );
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(response.status).toBe(503);
    expect(await problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(logs.lines.some((line) => line.includes('"outcome":"timeout"'))).toBe(true);
  });

  it('falha de rede → 503; 503 da API é repassado como veio', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    test.api.mockRejectedValueOnce(new TypeError('fetch failed'));
    const network = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(network.status).toBe(503);

    test.api.mockResolvedValueOnce(
      new Response('{"code":"DEPENDENCY_UNAVAILABLE"}', {
        status: 503,
        headers: { 'Content-Type': 'application/problem+json', 'X-Correlation-Id': 'c-api-9' },
      }),
    );
    const upstream = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      test.runtime,
    );
    expect(upstream.status).toBe(503);
    expect(upstream.headers.get('X-Correlation-Id')).toBe('c-api-9');
    expectSecurityHeaders(upstream);
  });

  it('exceção inesperada → 500 e log de erro', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const broken = {
      ...test.runtime,
      sessions: { lookup: () => Promise.reject(new Error('redis')) },
    };
    const response = await handleProxyRequest(
      browserRequest('/api/v1/me', { headers: { Cookie: cookie } }),
      ['me'],
      broken as unknown as typeof test.runtime,
    );
    expect(response.status).toBe(500);
    expect(logs.lines.some((line) => line.includes('"bff.unhandled_exception"'))).toBe(true);
  });
});
