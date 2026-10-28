import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_TRANSACTION_COOKIE, openTransactions } from '@/bff/auth/login-transaction';
import {
  AuthentikPasswordRecovery,
  RECOVERY_RETURN_COOKIE,
  pendingReturnTo,
} from '@/bff/auth/password-recovery';
import { handleAuthRequest } from '@/bff/auth-handler';
import { captureLogsForTests } from '@/bff/logger';
import { MemorySessionStore } from '@/bff/session/memory-store';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { SessionDirectory } from '@/bff/session/types';
import type { TestRuntime } from '@test/support/bff';
import { APP_ORIGIN, browserRequest, createTestRuntime, signIn } from '@test/support/bff';
import { requestUrl } from '@test/support/render';

/*
 * Feature: Recuperar senha (US-089) — a parte do ContrataFlow: `GET /api/auth/forgot-password`,
 * rota pública do BFF que só redireciona ao *flow* de recuperação do Authentik (RN-IAM-34/38), e
 * a volta a SCR-001. O que acontece dentro do Authentik (e-mail, política de senha, link de uso
 * único, mensagem genérica) é coberto contra o Authentik real em
 * tools/test/integration/authentik-recovery.test.ts.
 */

const FLOW_URL = 'http://localhost:9080/if/flow/contrataflow-recovery/';
/** Atrás do balanceador (TRUSTED_PROXY_CIDRS = 10.0.0.0/8): IP real do cliente. */
const BEHIND_ALB = { 'X-Forwarded-For': '203.0.113.7, 10.0.0.2', 'User-Agent': 'Vitest/1.0' };

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

function logged(event: string): Record<string, unknown>[] {
  return logs.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValue(response: Response, name: string): string {
  return /^[^=]+=([^;]*)/.exec(setCookieFor(response, name) ?? '')?.[1] ?? '';
}

/** Authentik simulado: a página do *flow* responde `status` (ou a rede cai). */
function authentik(state: { status: number | 'down' } = { status: 200 }) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    state.status === 'down'
      ? Promise.reject(new TypeError('fetch failed'))
      : Promise.resolve(new Response('<html></html>', { status: state.status })),
  );
  return { fetchMock, state };
}

/** Runtime com a recuperação no Authentik (simulado), como em produção. */
function authentikRuntime(
  idp = authentik(),
  options: { directory?: SessionDirectory; sessionStore?: MemorySessionStore } = {},
): TestRuntime {
  const test = createTestRuntime({
    ...options,
    recovery: new AuthentikPasswordRecovery({
      issuerUrl: 'http://localhost:9080/application/o/contrataflow/',
      flowSlug: 'contrataflow-recovery',
      fetch: idp.fetchMock,
      now: () => test.clock.now,
    }),
  });
  return test;
}

function forgot(test: TestRuntime, query = '', headers: Record<string, string> = {}) {
  return handleAuthRequest(
    browserRequest(`/api/auth/forgot-password${query}`, { headers: { ...BEHIND_ALB, ...headers } }),
    'forgot-password',
    test.runtime,
  );
}

/** Login com o provedor fake depois da redefinição: /login → callback → destino. */
async function loginAfterReset(test: TestRuntime, query: string, cookie = '') {
  const start = await handleAuthRequest(
    browserRequest(`/api/auth/login${query}`, { headers: { ...BEHIND_ALB, Cookie: cookie } }),
    'login',
    test.runtime,
  );
  const callbackUrl = new URL(start.headers.get('Location') ?? '');
  const callback = await handleAuthRequest(
    browserRequest(`${callbackUrl.pathname}${callbackUrl.search}`, {
      headers: {
        ...BEHIND_ALB,
        Cookie: `${LOGIN_TRANSACTION_COOKIE}=${cookieValue(start, LOGIN_TRANSACTION_COOKIE)}`,
      },
    }),
    'callback',
    test.runtime,
  );
  return { start, callback };
}

describe('Feature: Recuperar senha — GET /api/auth/forgot-password (US-089)', () => {
  it('[Sucesso] 302 para o flow de recuperação do Authentik, no-store e log sem dados do usuário', async () => {
    const idp = authentik();
    const test = authentikRuntime(idp);
    const response = await forgot(test, '?returnTo=%2Fprocessos%2F42');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(FLOW_URL);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Correlation-Id')).toBeTruthy();
    expect(await response.text()).toBe('');
    // O BFF conferiu que o IdP responde antes de mandar o navegador para lá.
    expect(idp.fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(idp.fetchMock.mock.calls[0]?.[0] ?? '')).toBe(FLOW_URL);

    expect(logged('auth.recovery_redirect')).toEqual([
      expect.objectContaining({
        level: 'info',
        returnToAccepted: true,
        ip: '203.0.113.x',
        correlationId: response.headers.get('X-Correlation-Id'),
      }),
    ]);
    // Nunca logar e-mail, senha, token ou link (DEC-138); nem o IP completo.
    expect(logs.lines.join('\n')).not.toMatch(/203\.0\.113\.7|@|token|senha/i);
  });

  it('[Sucesso] Cláudia redefine a senha, volta a /entrar?motivo=senha-redefinida e entra no destino pedido', async () => {
    // Provedor fake (FA-06): o "Authentik" conclui a redefinição e devolve direto a SCR-001.
    const test = createTestRuntime();
    const response = await forgot(test, '?returnTo=%2Fprocessos%2F42');
    expect(response.headers.get('Location')).toBe(`${APP_ORIGIN}/entrar?motivo=senha-redefinida`);

    // Nenhuma sessão criada automaticamente (passo 7): só o destino guardado (FA-05).
    expect(setCookieFor(response, test.runtime.config.sessionCookieName)).toBeUndefined();
    expect(test.store.size).toBe(0);
    const recoveryCookie = setCookieFor(response, RECOVERY_RETURN_COOKIE) ?? '';
    expect(recoveryCookie).toMatch(/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/);
    const returnTo = pendingReturnTo({
      recoveryCookie: cookieValue(response, RECOVERY_RETURN_COOKIE),
      transactions: [],
    });
    expect(returnTo).toBe('/processos/42');

    // SCR-001 → "Entrar" com o returnTo: login normal (US-087); o cookie da recuperação some.
    const { start, callback } = await loginAfterReset(
      test,
      '?returnTo=%2Fprocessos%2F42&as=ana',
      `${RECOVERY_RETURN_COOKIE}=${cookieValue(response, RECOVERY_RETURN_COOKIE)}`,
    );
    expect(setCookieFor(start, RECOVERY_RETURN_COOKIE)).toContain('Max-Age=0');
    expect(callback.headers.get('Location')).toBe('/processos/42');
    expect(setCookieFor(callback, test.runtime.config.sessionCookieName)).toBeTruthy();
  });

  it('[Validação] FA-05: returnTo fora do padrão é descartado em silêncio (V-03) e o fluxo segue', async () => {
    const test = authentikRuntime();
    const response = await forgot(test, '?returnTo=https%3A%2F%2Fevil.com%2F');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(FLOW_URL);
    // Nada guardado: o login seguinte vai para o início (/painel → HOME_PATH).
    expect(setCookieFor(response, RECOVERY_RETURN_COOKIE)).toContain('Max-Age=0');
    expect(logged('auth.return_to_rejected')).toHaveLength(1);
    expect(logged('auth.recovery_redirect')[0]).toMatchObject({ returnToAccepted: false });
  });

  it('[Validação] só GET: outro método → 405 com Allow', async () => {
    const test = authentikRuntime();
    const response = await handleAuthRequest(
      browserRequest('/api/auth/forgot-password', { method: 'POST' }),
      'forgot-password',
      test.runtime,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('[Permissão] rota pública: visitante sem sessão é redirecionado (sem 401)', async () => {
    const test = authentikRuntime();
    const response = await forgot(test);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(FLOW_URL);
  });

  it('[Permissão] FA-04: Bruno (BLOCKED) redefine a senha no IdP mas continua sem acesso', async () => {
    const test = createTestRuntime();
    const response = await forgot(test);
    expect(response.headers.get('Location')).toBe(`${APP_ORIGIN}/entrar?motivo=senha-redefinida`);
    // A pessoa bloqueada do provedor fake é a "eva"; a senha nova não concede acesso.
    const { callback } = await loginAfterReset(test, '?as=eva');
    expect(callback.headers.get('Location')).toBe('/erro/acesso-bloqueado');
    expect(setCookieFor(callback, test.runtime.config.sessionCookieName)).toBeUndefined();
    expect(test.store.size).toBe(0);
  });

  it('[Tenant incorreto] não aceita nem expõe tenant, sessão ou dado do usuário', async () => {
    const test = authentikRuntime();
    const { cookie } = await signIn(test, 'ana');
    const sessions = test.store.size;
    logs.lines.length = 0;
    const response = await forgot(test, '?email=claudia%40pmsj.gov.br&tenantId=t-1&username=x', {
      'X-Tenant-Id': '0192a000-0000-7000-8000-00000000000b',
      Cookie: cookie,
    });
    // A URL do IdP não carrega nada da requisição: nem e-mail, nem tenant, nem sessão.
    expect(response.headers.get('Location')).toBe(FLOW_URL);
    expect(response.headers.get('X-Tenant-Id')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(new RegExp(`^${RECOVERY_RETURN_COOKIE}=;`)),
    ]);
    // A sessão existente não é lida, renovada nem encerrada; a API não é chamada.
    expect(test.store.size).toBe(sessions);
    expect(test.api).not.toHaveBeenCalled();
    expect(logs.lines.join('\n')).not.toMatch(/claudia|pmsj|0192a000/);
  });

  it('[Duplicidade] pedidos repetidos dão o mesmo destino; o returnTo mais recente prevalece', async () => {
    const idp = authentik();
    const test = authentikRuntime(idp);
    const first = await forgot(test, '?returnTo=%2Fprocessos%2F1');
    const second = await forgot(test, '?returnTo=%2Fprocessos%2F2');
    expect(first.headers.get('Location')).toBe(second.headers.get('Location'));
    expect(cookieValue(second, RECOVERY_RETURN_COOKIE)).toBe('%2Fprocessos%2F2');
    // Sondagem do IdP reaproveitada dentro de 10 s.
    expect(idp.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[Concorrência] RN-IAM-38: o limite de 20 req/min por IP vale aqui e é o mesmo de /api/auth/*', async () => {
    const test = authentikRuntime();
    const responses = await Promise.all(Array.from({ length: 15 }, () => forgot(test)));
    expect(responses.every((response) => response.status === 302)).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await handleAuthRequest(
        browserRequest('/api/auth/login', { headers: BEHIND_ALB }),
        'login',
        test.runtime,
      );
    }
    const limited = await forgot(test);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(logged('auth.rate_limited').at(-1)).toMatchObject({
      route: '/api/auth/forgot-password',
    });
  });

  it('[Falha de banco] API/PostgreSQL e Redis de sessões fora do ar não afetam o redirecionamento', async () => {
    const failing = new MemorySessionStore();
    for (const method of ['get', 'save', 'create'] as const) {
      vi.spyOn(failing, method).mockRejectedValue(new SessionStoreUnavailableError());
    }
    const startSession = vi.fn(() => Promise.resolve({ kind: 'unavailable' as const }));
    const activateTenant = vi.fn(() => Promise.resolve({ kind: 'unavailable' as const }));
    const directory: SessionDirectory = { startSession, activateTenant };
    const test = authentikRuntime(authentik(), { directory, sessionStore: failing });
    const response = await forgot(test, '', { Cookie: '__Host-cf_session=qualquer' });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(FLOW_URL);
    expect(startSession).not.toHaveBeenCalled();
    expect(test.api).not.toHaveBeenCalled();
  });

  it('[Falha de integração] Authentik indisponível: SCR-002 com a mensagem, returnTo preservado e warn', async () => {
    const idp = authentik({ status: 'down' });
    const test = authentikRuntime(idp);
    const response = await forgot(test, '?returnTo=%2Fprocessos%3Fx%3D1');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/recuperar-senha?motivo=indisponivel&returnTo=%2Fprocessos%3Fx%3D1',
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(logged('auth.recovery_unavailable')).toEqual([
      expect.objectContaining({ level: 'warn', providerStatus: null }),
    ]);
    expect(logged('auth.recovery_redirect')).toEqual([]);

    // Flow não publicado (URL errada): mesma experiência, com o status no log.
    idp.state.status = 404;
    const missing = await forgot(test);
    expect(missing.headers.get('Location')).toBe('/recuperar-senha?motivo=indisponivel');
    expect(logged('auth.recovery_unavailable').at(-1)).toMatchObject({ providerStatus: 404 });

    // "Tentar novamente" com o IdP de volta segue para o Authentik.
    idp.state.status = 200;
    expect((await forgot(test)).headers.get('Location')).toBe(FLOW_URL);
  });

  it('erro inesperado no BFF → 500 INTERNAL_ERROR com correlationId', async () => {
    const test = createTestRuntime({
      recovery: { recoveryUrl: () => Promise.reject(new Error('bug')) },
    });
    const response = await forgot(test);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; correlationId: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.correlationId).toBe(response.headers.get('X-Correlation-Id'));
    expect(logged('bff.unhandled_exception')[0]).toMatchObject({
      route: '/api/auth/forgot-password',
    });
  });
});

describe('FA-05 — recuperação iniciada no formulário do Authentik (step-up)', () => {
  it('o returnTo do login em curso é o destino após a redefinição', async () => {
    const test = createTestRuntime();
    // Transação OIDC no navegador: só o step-up (e o atalho fake ?as=) ainda passam pelo IdP.
    const start = await handleAuthRequest(
      browserRequest('/api/auth/login?returnTo=%2Fprocessos%2F7&as=ana', { headers: BEHIND_ALB }),
      'login',
      test.runtime,
    );
    const transactions = openTransactions(
      test.runtime.transactionKey,
      cookieValue(start, LOGIN_TRANSACTION_COOKIE),
      test.clock.now,
    );
    expect(pendingReturnTo({ recoveryCookie: null, transactions })).toBe('/processos/7');
  });
});
