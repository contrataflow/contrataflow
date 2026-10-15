import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_TRANSACTION_COOKIE } from '@/bff/auth/login-transaction';
import { newLoginSecrets } from '@/bff/auth/pkce';
import { handleAuthRequest, selectTenant } from '@/bff/auth-handler';
import { captureLogsForTests } from '@/bff/logger';
import { handleProxyRequest } from '@/bff/proxy-handler';
import { MemorySessionStore } from '@/bff/session/memory-store';
import { hashSessionId } from '@/bff/session/session-service';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type {
  DirectoryResult,
  IdentityProvider,
  LoginFailureReason,
  MembershipSummary,
  SessionDirectory,
} from '@/bff/session/types';
import { browserRequest, createTestRuntime, lastApiCall } from '@test/support/bff';
import type { TestRuntime } from '@test/support/bff';

/*
 * US-087 — Gherkin do login OIDC no BFF: sessão segura, seleção de instituição, recusas, falhas de
 * integração e limites. O IdP e a API são simulados (os contratos têm testes próprios).
 */

const TENANT_SJ = '0192a000-0000-7000-8000-0000000000a5';
const TENANT_SL = '0192a000-0000-7000-8000-0000000000b5';
const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };
/** Atrás do balanceador (TRUSTED_PROXY_CIDRS = 10.0.0.0/8): IP real do cliente. */
const BEHIND_ALB = { 'X-Forwarded-For': '203.0.113.7, 10.0.0.2', 'User-Agent': 'Vitest/1.0' };
const SECRET_FRAGMENTS = ['access-', 'refresh-segredo', 'id-token-segredo'];

function membership(tenantId: string, name: string, overrides: Partial<MembershipSummary> = {}) {
  return {
    membershipId: `${tenantId.slice(0, -2)}m1`,
    tenant: {
      id: tenantId,
      name,
      status: 'ACTIVE',
      timezone: 'America/Sao_Paulo',
      primaryColor: null,
    },
    type: 'INTERNAL',
    status: 'ACTIVE',
    expiresAt: null,
    usable: true,
    readOnly: false,
    ...overrides,
  } satisfies MembershipSummary;
}

const CLAUDIA = [membership(TENANT_SJ, 'Prefeitura de São José')];

/** Provedor OIDC simulado: códigos de uso único, falha configurável. */
function stubProvider(clock: { now: number }) {
  const used = new Set<string>();
  const state: { fail: LoginFailureReason | null; subject: string } = {
    fail: null,
    subject: 'sub-claudia',
  };
  const provider: IdentityProvider = {
    kind: 'oidc',
    beginLogin: () => {
      const secrets = newLoginSecrets();
      return Promise.resolve({
        ...secrets,
        redirectUrl: `http://localhost:9080/application/o/authorize/?state=${secrets.state}`,
      });
    },
    completeLogin: (params) => {
      if (state.fail) return Promise.resolve({ ok: false, reason: state.fail });
      const code = params.get('code') ?? '';
      if (used.has(code)) return Promise.resolve({ ok: false, reason: 'TOKEN_INVALID' });
      used.add(code);
      return Promise.resolve({
        ok: true,
        login: {
          subject: state.subject,
          tokens: {
            accessToken: `access-${code}`,
            accessTokenExpiresAt: clock.now + 300_000,
            refreshToken: 'refresh-segredo',
            idToken: 'id-token-segredo',
          },
          amr: ['pwd'],
          authTime: clock.now,
        },
      });
    },
    refresh: () => Promise.resolve({ kind: 'transient' }),
    revokeRefreshToken: () => Promise.resolve('skipped' as const),
    endSessionUrl: () => Promise.resolve(null),
  };
  return { provider, state };
}

/** API simulada como diretório: vínculos configuráveis e registro das chamadas. */
function stubDirectory() {
  const state: {
    start: DirectoryResult;
    activation: ((tenantId: string) => DirectoryResult) | null;
  } = {
    start: {
      kind: 'ok',
      user: { id: '0192a000-0000-7000-8000-0000000000c9', displayName: 'Cláudia Ferreira' },
      firstLogin: false,
      memberships: CLAUDIA,
      defaultTenantId: null,
      active: null,
    },
    activation: null,
  };
  const startSession = vi.fn<SessionDirectory['startSession']>(() => Promise.resolve(state.start));
  const activateTenant = vi.fn<SessionDirectory['activateTenant']>((input) => {
    if (state.activation) return Promise.resolve(state.activation(input.tenantId));
    if (state.start.kind !== 'ok') return Promise.resolve(state.start);
    const target = state.start.memberships.find((item) => item.tenant.id === input.tenantId);
    return Promise.resolve(
      target?.usable
        ? {
            ...state.start,
            firstLogin: input.firstLogin,
            active: {
              membershipId: target.membershipId,
              tenantId: target.tenant.id,
              readOnly: target.readOnly,
            },
          }
        : { kind: 'no_membership' },
    );
  });
  const directory: SessionDirectory = { startSession, activateTenant };
  return { directory, state, startSession, activateTenant };
}

interface Harness {
  readonly test: TestRuntime;
  readonly provider: ReturnType<typeof stubProvider>;
  readonly api: ReturnType<typeof stubDirectory>;
}

function harness(options: { sessionStore?: MemorySessionStore } = {}): Harness {
  const clock = { now: Date.parse('2026-10-14T12:00:00Z') };
  const provider = stubProvider(clock);
  const api = stubDirectory();
  const test = createTestRuntime({
    identity: provider.provider,
    directory: api.directory,
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
  });
  test.clock.now = clock.now;
  return { test, provider, api };
}

function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const value = new RegExp(`${name}=([^;,]*)`).exec(setCookie)?.[1];
  if (!value) return null;
  return value;
}

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

async function begin(h: Harness, query = '?returnTo=%2Fprocessos%2F0192aa', cookie = '') {
  const response = await handleAuthRequest(
    browserRequest(`/api/auth/login${query}`, { headers: { ...BEHIND_ALB, Cookie: cookie } }),
    'login',
    h.test.runtime,
  );
  const location = response.headers.get('Location');
  const state = location ? (new URL(location).searchParams.get('state') ?? '') : '';
  const transactions =
    cookieValue(response.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
  return { response, state, transactions };
}

function finish(h: Harness, state: string, transactions: string, code = 'C1', extraCookie = '') {
  const cookies = [`${LOGIN_TRANSACTION_COOKIE}=${transactions}`, extraCookie].filter(Boolean);
  return handleAuthRequest(
    browserRequest(`/api/auth/callback?code=${code}&state=${state}`, {
      headers: { ...BEHIND_ALB, Cookie: cookies.join('; ') },
    }),
    'callback',
    h.test.runtime,
  );
}

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

describe('Feature: Login OIDC com Authentik e sessão segura no BFF (US-087)', () => {
  it('[Sucesso] um único vínculo: sessão segura, instituição automática e volta à página pedida', async () => {
    const h = harness();
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/processos/0192aa');
    expect(callback.headers.get('Cache-Control')).toBe('private, no-store');
    const sessionCookie = setCookieFor(callback, '__Host-cf_session') ?? '';
    expect(sessionCookie).toMatch(
      /^__Host-cf_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(sessionCookie).not.toContain('Domain');
    expect(sessionCookie).not.toContain('Max-Age');
    // A transação de login some depois de usada.
    expect(setCookieFor(callback, LOGIN_TRANSACTION_COOKIE)).toContain('Max-Age=0');

    // Instituição ativa sem passar pela seleção, conferida pela API (AUTO).
    const sid = cookieValue(sessionCookie, '__Host-cf_session') ?? '';
    const record = await h.test.store.get(hashSessionId(sid));
    if (!record) throw new Error('sessão não criada');
    expect(record.activeTenantId).toBe(TENANT_SJ);
    expect(record.ip).toBe('203.0.113.7');
    expect(h.api.activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_SJ,
        kind: 'start',
        selection: 'AUTO',
        sessionIdHash: hashSessionId(sid),
        ip: '203.0.113.7',
        userAgent: 'Vitest/1.0',
      }),
    );
    expect(logged('auth.session_created')[0]).toMatchObject({
      tenantId: TENANT_SJ,
      selection: 'AUTO',
      sessionIdHashPrefix: hashSessionId(sid).slice(0, 8),
    });

    // Nenhum token chega ao navegador: nem cabeçalhos, nem corpo, nem a sessão pública.
    const session = await handleAuthRequest(
      browserRequest('/api/auth/session', { headers: { Cookie: `__Host-cf_session=${sid}` } }),
      'session',
      h.test.runtime,
    );
    const body = await session.text();
    const exposed = [
      ...callback.headers.getSetCookie(),
      callback.headers.get('Location') ?? '',
      await callback.text(),
      body,
      ...logs.lines,
    ].join(' ');
    for (const fragment of SECRET_FRAGMENTS) expect(exposed).not.toContain(fragment);
    // O id da sessão só existe no cookie HttpOnly — nunca em corpo, URL ou log.
    expect([body, ...logs.lines].join(' ')).not.toContain(sid);
  });

  it('[Sucesso] primeiro login: firstLogin vai para a sessão e para auth.session_start', async () => {
    const h = harness();
    if (h.api.state.start.kind === 'ok')
      h.api.state.start = { ...h.api.state.start, firstLogin: true };
    const { state, transactions } = await begin(h);
    await finish(h, state, transactions);
    expect(h.api.activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({ firstLogin: true, selection: 'AUTO' }),
    );
    expect(logged('auth.session_created')[0]).toMatchObject({ firstLogin: true });
  });

  it('FA-01: vários vínculos sem padrão → SCR-101 com o returnTo, sem instituição ativa', async () => {
    const h = harness();
    if (h.api.state.start.kind === 'ok') {
      h.api.state.start = {
        ...h.api.state.start,
        memberships: [...CLAUDIA, membership(TENANT_SL, 'Prefeitura de Santa Luzia')],
      };
    }
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe(
      '/selecionar-orgao?returnTo=%2Fprocessos%2F0192aa',
    );
    expect(h.api.activateTenant).not.toHaveBeenCalled();
    expect(setCookieFor(callback, '__Host-cf_session')).toBeDefined();
  });

  it('RN-IAM-09: seleção automática, padrão ou nenhuma', () => {
    const a = membership(TENANT_SJ, 'A');
    const b = membership(TENANT_SL, 'B');
    const off = { ...b, usable: false };
    expect(selectTenant({ memberships: [a], defaultTenantId: null })).toEqual({
      tenantId: TENANT_SJ,
      selection: 'AUTO',
    });
    expect(selectTenant({ memberships: [a, off], defaultTenantId: TENANT_SL })).toEqual({
      tenantId: TENANT_SJ,
      selection: 'AUTO',
    });
    expect(selectTenant({ memberships: [a, b], defaultTenantId: TENANT_SL })).toEqual({
      tenantId: TENANT_SL,
      selection: 'DEFAULT',
    });
    expect(selectTenant({ memberships: [a, b], defaultTenantId: null })).toBeNull();
    expect(selectTenant({ memberships: [], defaultTenantId: null })).toBeNull();
  });

  it('[Validação] returnTo externo é descartado: após o login, volta ao início', async () => {
    const h = harness();
    const { state, transactions } = await begin(h, '?returnTo=%2F%2Fsite-malicioso.com%2Fx');
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe('/exemplo');
    expect(logged('auth.return_to_rejected')).toHaveLength(1);
  });

  it('[Validação] state divergente no callback: nenhuma sessão e "Não foi possível concluir a entrada"', async () => {
    const h = harness();
    const { transactions } = await begin(h);
    const callback = await finish(h, 'S2-forjado', transactions);
    expect(callback.headers.get('Location')).toBe('/entrar?motivo=erro');
    expect(setCookieFor(callback, '__Host-cf_session')).toBeUndefined();
    // A transação legítima (S1) continua disponível para a aba que a iniciou.
    expect(setCookieFor(callback, LOGIN_TRANSACTION_COOKIE)).toContain('Max-Age=600');
    expect(h.test.store.size).toBe(0);
    expect(logged('auth.callback_rejected')[0]).toMatchObject({ reason: 'STATE_MISMATCH' });
  });

  it('[Validação] id_token com nonce incorreto: nenhuma sessão e warn auth.callback_rejected', async () => {
    const h = harness();
    h.provider.state.fail = 'NONCE_MISMATCH';
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe('/entrar?motivo=erro');
    expect(h.test.store.size).toBe(0);
    expect(logged('auth.callback_rejected')[0]).toMatchObject({
      level: 'warn',
      reason: 'NONCE_MISMATCH',
    });
    expect(h.api.startSession).not.toHaveBeenCalled();
  });

  it('[Permissão] usuário bloqueado pela plataforma: sem sessão, página 403 de bloqueio', async () => {
    const h = harness();
    h.api.state.start = { kind: 'blocked' };
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe('/erro/acesso-bloqueado');
    expect(h.test.store.size).toBe(0);
  });

  it('[Permissão] único vínculo suspenso: "sem vínculo" e a API recusa com MEMBERSHIP_INACTIVE', async () => {
    const h = harness();
    if (h.api.state.start.kind === 'ok') {
      h.api.state.start = {
        ...h.api.state.start,
        memberships: [
          membership(TENANT_SJ, 'Prefeitura de São José', { status: 'SUSPENDED', usable: false }),
        ],
      };
    }
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe('/erro/sem-vinculo');
    const sid = cookieValue(setCookieFor(callback, '__Host-cf_session') ?? '', '__Host-cf_session');
    // Sessão sem instituição (FA-02): a API recebe a chamada sem X-Tenant-Id e responde 403.
    h.test.api.mockResolvedValueOnce(
      Response.json({ code: 'MEMBERSHIP_INACTIVE' }, { status: 403 }),
    );
    const response = await handleProxyRequest(
      browserRequest('/api/v1/processes', { headers: { Cookie: `__Host-cf_session=${sid}` } }),
      ['processes'],
      h.test.runtime,
    );
    expect(response.status).toBe(403);
    expect(new Headers(lastApiCall(h.test.api).init.headers).has('X-Tenant-Id')).toBe(false);
  });

  it('[Tenant incorreto] cabeçalhos forjados pelo navegador são descartados; vale o tenant da sessão', async () => {
    const h = harness();
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    const sid = cookieValue(setCookieFor(callback, '__Host-cf_session') ?? '', '__Host-cf_session');
    await handleProxyRequest(
      browserRequest('/api/v1/processes', {
        headers: {
          Cookie: `__Host-cf_session=${sid}`,
          'X-Tenant-Id': TENANT_SL,
          Authorization: 'Bearer forjado',
          'X-Forwarded-For': '6.6.6.6',
        },
      }),
      ['processes'],
      h.test.runtime,
    );
    const headers = new Headers(lastApiCall(h.test.api).init.headers);
    expect(headers.get('X-Tenant-Id')).toBe(TENANT_SJ);
    expect(headers.get('Authorization')).toBe('Bearer access-C1');
    expect(headers.get('Cookie')).toBeNull();
  });

  it('[Duplicidade] reenvio do mesmo callback é recusado sem criar segunda sessão', async () => {
    const h = harness();
    const { state, transactions } = await begin(h);
    const first = await finish(h, state, transactions);
    const updated = cookieValue(first.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    // O navegador reenviando com o cookie atual: a transação já foi consumida.
    const replay = await finish(h, state, updated);
    expect(replay.headers.get('Location')).toBe('/entrar?motivo=erro');
    // Um atacante com o cookie antigo: o IdP recusa o código já trocado.
    const stolen = await finish(h, state, transactions);
    expect(stolen.headers.get('Location')).toBe('/entrar?motivo=erro');
    expect(h.test.store.size).toBe(1);
    expect(logged('auth.callback_rejected').map((entry) => entry.reason)).toEqual([
      'STATE_MISMATCH',
      'TOKEN_INVALID',
    ]);
  });

  it('[Duplicidade] login iniciado em duas abas: as duas transações coexistem e concluem', async () => {
    const h = harness();
    const tab1 = await begin(h);
    const tab2 = await begin(
      h,
      '?returnTo=%2Ftarefas',
      `${LOGIN_TRANSACTION_COOKIE}=${tab1.transactions}`,
    );
    const second = await finish(h, tab2.state, tab2.transactions, 'C2');
    expect(second.headers.get('Location')).toBe('/tarefas');
    const remaining = cookieValue(second.headers.get('Set-Cookie'), LOGIN_TRANSACTION_COOKIE) ?? '';
    const first = await finish(h, tab1.state, remaining, 'C1');
    expect(first.headers.get('Location')).toBe('/processos/0192aa');
    expect(logged('auth.callback_rejected')).toEqual([]);
  });

  it('[Falha de banco] API/banco indisponível no início da sessão: nenhuma sessão, manutenção com correlationId', async () => {
    const h = harness();
    h.api.state.start = { kind: 'unavailable' };
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    const location = new URL(callback.headers.get('Location') ?? '', 'http://x');
    expect(location.pathname).toBe('/erro/manutencao');
    expect(location.searchParams.get('codigo')).toBe(callback.headers.get('X-Correlation-Id'));
    expect(location.searchParams.get('retorno')).toBe('/processos/0192aa');
    expect(h.test.store.size).toBe(0);
  });

  it('[Falha de integração] Authentik indisponível na troca do código: "serviço indisponível", sem sessão', async () => {
    const h = harness();
    h.provider.state.fail = 'PROVIDER_UNAVAILABLE';
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe(
      '/entrar?motivo=indisponivel&returnTo=%2Fprocessos%2F0192aa',
    );
    expect(h.test.store.size).toBe(0);
  });

  it('[Falha de integração] Redis de sessões indisponível: 503 com Retry-After e nenhum cookie de sessão', async () => {
    const failing = new MemorySessionStore();
    vi.spyOn(failing, 'create').mockRejectedValue(new SessionStoreUnavailableError());
    const h = harness({ sessionStore: failing });
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.status).toBe(503);
    expect(callback.headers.get('Retry-After')).toBe('5');
    expect(((await callback.json()) as { code: string }).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(setCookieFor(callback, '__Host-cf_session')).toBeUndefined();
    expect(h.api.activateTenant).not.toHaveBeenCalled();
  });

  it('ativação recusada pela API depois de criar a sessão: segue sem instituição (seleção)', async () => {
    const h = harness();
    h.api.state.activation = () => ({ kind: 'unavailable' });
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    expect(callback.headers.get('Location')).toBe(
      '/selecionar-orgao?returnTo=%2Fprocessos%2F0192aa',
    );
    expect(logged('auth.tenant_activation_failed')[0]).toMatchObject({ result: 'unavailable' });
  });

  it('identidade recusada pela API (token inválido / sem cadastro) → SCR-001 erro / "sem vínculo"', async () => {
    const h = harness();
    h.api.state.start = { kind: 'unauthenticated' };
    let flow = await begin(h);
    expect((await finish(h, flow.state, flow.transactions)).headers.get('Location')).toBe(
      '/entrar?motivo=erro',
    );
    h.api.state.start = { kind: 'no_membership' };
    flow = await begin(h);
    expect((await finish(h, flow.state, flow.transactions, 'C9')).headers.get('Location')).toBe(
      '/erro/sem-vinculo',
    );
    expect(h.test.store.size).toBe(0);
  });

  it('RN-IAM-15: mais de 20 tentativas por minuto do mesmo IP → 429 RATE_LIMITED com Retry-After', async () => {
    const h = harness();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await begin(h)).response.status).toBe(302);
    }
    const limited = await begin(h);
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('Retry-After')).toBe('60');
    expect((await limited.response.json()) as { code: string; detail: string }).toMatchObject({
      code: 'RATE_LIMITED',
      detail: 'Muitas tentativas. Aguarde alguns instantes.',
    });
    const callback = await finish(h, 'x', '');
    expect(callback.status).toBe(429);
  });

  it('o cookie de transação nunca passa de ~4 KB: transações antigas saem primeiro', async () => {
    const h = harness();
    const longPath = `/processos?q=${'a'.repeat(1_900)}`;
    let jar = '';
    for (let tab = 0; tab < 3; tab += 1) {
      const flow = await begin(
        h,
        `?returnTo=${encodeURIComponent(longPath)}`,
        jar ? `${LOGIN_TRANSACTION_COOKIE}=${jar}` : '',
      );
      jar = flow.transactions;
      expect(jar.length).toBeLessThan(3_900);
    }
  });
});

describe('POST /api/auth/switch-tenant (US-087 · SCR-101)', () => {
  async function signedInWithoutTenant(h: Harness) {
    if (h.api.state.start.kind === 'ok') {
      h.api.state.start = {
        ...h.api.state.start,
        memberships: [...CLAUDIA, membership(TENANT_SL, 'Prefeitura de Santa Luzia')],
      };
    }
    const { state, transactions } = await begin(h);
    const callback = await finish(h, state, transactions);
    return `__Host-cf_session=${cookieValue(setCookieFor(callback, '__Host-cf_session') ?? '', '__Host-cf_session') ?? ''}`;
  }

  function choose(h: Harness, cookie: string, tenantId: string) {
    return handleAuthRequest(
      browserRequest('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { ...MUTATION, ...BEHIND_ALB, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      }),
      'switch-tenant',
      h.test.runtime,
    );
  }

  it('primeira escolha grava auth.session_start (MANUAL); a seguinte é troca (TENANT_SWITCHED)', async () => {
    const h = harness();
    const cookie = await signedInWithoutTenant(h);
    const first = await choose(h, cookie, TENANT_SL);
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { data: { activeTenant: { id: string } } }).data.activeTenant.id,
    ).toBe(TENANT_SL);
    expect(h.api.activateTenant).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'start', selection: 'MANUAL', fromTenantId: null }),
    );
    await choose(h, cookie, TENANT_SJ);
    expect(h.api.activateTenant).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'switch', fromTenantId: TENANT_SL, tenantId: TENANT_SJ }),
    );
    // Mesma instituição: no-op idempotente, sem nova chamada à API.
    const calls = h.api.activateTenant.mock.calls.length;
    expect((await choose(h, cookie, TENANT_SJ)).status).toBe(200);
    expect(h.api.activateTenant).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ['tenant_unavailable', 'TENANT_SUSPENDED', 403],
    ['no_membership', 'MEMBERSHIP_INACTIVE', 403],
    ['blocked', 'PERMISSION_DENIED', 403],
    ['unauthenticated', 'SESSION_EXPIRED', 401],
    ['unavailable', 'DEPENDENCY_UNAVAILABLE', 503],
  ] as const)('recusa da API %s → %s', async (kind, code, status) => {
    const h = harness();
    const cookie = await signedInWithoutTenant(h);
    h.api.state.activation = () => ({ kind });
    const response = await choose(h, cookie, TENANT_SL);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { code: string }).code).toBe(code);
  });
});
