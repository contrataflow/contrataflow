import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogsForTests } from '@/bff/logger';
import { handleProxyRequest } from '@/bff/proxy-handler';
import { MemorySessionStore } from '@/bff/session/memory-store';
import { REFRESH_WAIT_MS, SessionService, hashSessionId } from '@/bff/session/session-service';
import type {
  IdentityProvider,
  RefreshResult,
  SessionRecord,
  SessionTokens,
} from '@/bff/session/types';
import { POLLING_ROUTES, isPollingRequest } from '@/lib/session/polling';
import type { TestRuntime } from '@test/support/bff';
import { browserRequest, createTestRuntime, lastApiCall, signIn } from '@test/support/bff';

/*
 * US-088 no BFF: ociosidade deslizante (sondagens não contam), duração absoluta, encerramento com
 * motivo e horário do fato, renovação transparente com trava (no processo e entre réplicas) e
 * falhas do Authentik. Os cenários seguem o Gherkin da story.
 */

const MINUTE = 60_000;
const ACTION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

async function problemCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

function get(test: TestRuntime, cookie: string, path: string): Promise<Response> {
  return handleProxyRequest(
    browserRequest(`/api/v1${path}`, { headers: { Cookie: cookie } }),
    path.split('/').filter(Boolean),
    test.runtime,
  );
}

function newTokens(now: number, label: string): SessionTokens {
  return {
    accessToken: `access-${label}`,
    accessTokenExpiresAt: now + 300_000,
    refreshToken: `refresh-${label}`,
    idToken: null,
  };
}

/** Provedor que delega ao fake, com a renovação sob controle do teste. */
function withRefresh(test: TestRuntime, refresh: IdentityProvider['refresh']): IdentityProvider {
  const identity = test.runtime.identity;
  return {
    kind: identity.kind,
    beginLogin: (input) => identity.beginLogin(input),
    completeLogin: (params, secrets) => identity.completeLogin(params, secrets),
    refresh,
    revokeRefreshToken: (record) => identity.revokeRefreshToken(record),
    endSessionUrl: () => identity.endSessionUrl(),
  };
}

describe('ociosidade (RN-IAM-21/24)', () => {
  it('[Sucesso] 31 min sem interagir → 401 SESSION_EXPIRED; encerramento IDLE no limite', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 31 * MINUTE;
    const response = await handleProxyRequest(
      browserRequest('/api/v1/dfds/1/sections/JUSTIFICATION', {
        method: 'PUT',
        headers: { ...ACTION, Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{"content":"trecho digitado"}',
      }),
      ['dfds', '1', 'sections', 'JUSTIFICATION'],
      test.runtime,
    );
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(test.api).not.toHaveBeenCalled();
    // Horário do fato = último uso + 30 min (não o da detecção).
    expect(test.store.endings()).toMatchObject([
      { key: record.key, reason: 'IDLE', occurredAt: record.lastSeenAt + 30 * MINUTE },
    ]);
    const line = logs.lines.find((entry) => entry.includes('"event":"auth.session_expired"'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ reason: 'IDLE', idleMinutes: 30 });
  });

  it('[Validação] sondagens a cada minuto não estendem a ociosidade', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    for (let minute = 1; minute <= 29; minute += 1) {
      test.clock.now = record.lastSeenAt + minute * MINUTE;
      expect((await get(test, cookie, '/notifications/unread-count')).status).toBe(200);
      expect((await get(test, cookie, '/tasks/counters')).status).toBe(200);
    }
    expect((await test.store.get(record.key))?.lastSeenAt).toBe(record.lastSeenAt);
    test.clock.now = record.lastSeenAt + 31 * MINUTE;
    const response = await get(test, cookie, '/notifications/unread-count');
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(test.store.endings()[0]?.reason).toBe('IDLE');
  });

  it('[Sucesso] FA-02 ação do usuário renova a ociosidade', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 20 * MINUTE;
    await get(test, cookie, '/processes');
    test.clock.now += 20 * MINUTE;
    expect((await get(test, cookie, '/processes')).status).toBe(200);
    expect((await test.store.get(record.key))?.idleExpiresAt).toBe(test.clock.now + 30 * MINUTE);
  });

  it('classificação: só GET dos contadores é sondagem', () => {
    expect([...POLLING_ROUTES]).toEqual(['/notifications/unread-count', '/tasks/counters']);
    expect(isPollingRequest('get', '/tasks/counters')).toBe(true);
    expect(isPollingRequest('POST', '/tasks/counters')).toBe(false);
    expect(isPollingRequest('GET', '/notifications')).toBe(false);
  });
});

describe('limites da instituição ativa (DEC-131 · security.sessionIdleMinutes/AbsoluteHours)', () => {
  it('ociosidade e duração absoluta recalculadas ao ativar a instituição', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    test.clock.now += 10 * MINUTE;
    const tight = await test.runtime.sessions.activateTenant(record, {
      tenantId: 't',
      membershipId: 'm',
      sessionPolicy: { idleMinutes: 5, absoluteHours: 1 },
    });
    expect(tight.idleMinutes).toBe(5);
    expect(tight.idleExpiresAt).toBe(record.lastSeenAt + 5 * MINUTE);
    expect(tight.absoluteExpiresAt).toBe(record.createdAt + 60 * MINUTE);
    // Fora da faixa da plataforma → padrão.
    const invalid = await test.runtime.sessions.activateTenant(record, {
      tenantId: 't',
      membershipId: 'm',
      sessionPolicy: { idleMinutes: 500, absoluteHours: 48 },
    });
    expect(invalid.idleMinutes).toBe(30);
    expect(invalid.absoluteExpiresAt).toBe(record.createdAt + 12 * 60 * MINUTE);
  });
});

describe('renovação do access token (RN-IAM-25/26)', () => {
  it('[Sucesso] token vence em 30 s → renovado com rotação do refresh antes de encaminhar', async () => {
    const base = createTestRuntime();
    const refresh = vi.fn(() =>
      Promise.resolve<RefreshResult>({ kind: 'ok', tokens: newTokens(Date.now(), 'novo') }),
    );
    const test = createTestRuntime({ identity: withRefresh(base, refresh) });
    const { cookie, record } = await signIn(test);
    test.clock.now = record.tokens.accessTokenExpiresAt - 30_000;
    const response = await get(test, cookie, '/processes');
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(lastApiCall(test.api).init.headers).get('Authorization')).toBe(
      'Bearer access-novo',
    );
    expect((await test.store.get(record.key))?.tokens.refreshToken).toBe('refresh-novo');
  });

  it.each([10, 100])(
    '[Concorrência] %i requisições paralelas com token vencido → uma única renovação',
    async (parallel) => {
      const base = createTestRuntime();
      const refresh = vi.fn(
        () =>
          new Promise<RefreshResult>((resolve) => {
            setTimeout(() => {
              resolve({ kind: 'ok', tokens: newTokens(Date.now() + 10 * MINUTE, 'novo') });
            }, 10);
          }),
      );
      const test = createTestRuntime({ identity: withRefresh(base, refresh) });
      const { cookie, record } = await signIn(test);
      test.clock.now = record.tokens.accessTokenExpiresAt + 1;
      const responses = await Promise.all(
        Array.from({ length: parallel }, () => get(test, cookie, '/processes')),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const sent = test.api.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get('Authorization'),
      );
      expect(sent).toHaveLength(parallel);
      expect(new Set(sent)).toEqual(new Set(['Bearer access-novo']));
    },
  );

  it('[Falha de integração] Authentik não responde e token vencido → 503, sessão preservada', async () => {
    const base = createTestRuntime();
    const test = createTestRuntime({
      identity: withRefresh(base, () => Promise.resolve({ kind: 'transient' })),
    });
    const { cookie, record } = await signIn(test);
    test.clock.now = record.tokens.accessTokenExpiresAt + 1;
    const response = await handleProxyRequest(
      browserRequest('/api/v1/dfds/1', {
        method: 'PATCH',
        headers: { ...ACTION, Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      ['dfds', '1'],
      test.runtime,
    );
    expect(response.status).toBe(503);
    expect(await problemCode(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(await test.store.get(record.key)).not.toBeNull();
    expect(test.store.endings()).toEqual([]);
    const warn = logs.lines.find((line) => line.includes('"event":"auth.refresh_failed"'));
    expect(JSON.parse(warn ?? '{}')).toMatchObject({ level: 'warn', type: 'TRANSIENT' });
  });

  it('[Falha de integração] invalid_grant → 401 SESSION_EXPIRED e encerramento REFRESH_FAILED', async () => {
    const base = createTestRuntime();
    const test = createTestRuntime({
      identity: withRefresh(base, () => Promise.resolve({ kind: 'invalid_grant' })),
    });
    const { cookie, record } = await signIn(test);
    test.clock.now = record.tokens.accessTokenExpiresAt - 1_000;
    const response = await get(test, cookie, '/processes');
    expect(response.status).toBe(401);
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(test.store.endings()).toMatchObject([{ key: record.key, reason: 'REFRESH_FAILED' }]);
    const warn = logs.lines.find((line) => line.includes('"event":"auth.refresh_failed"'));
    expect(JSON.parse(warn ?? '{}')).toMatchObject({ type: 'INVALID_GRANT' });
    // As próximas requisições da mesma aba (ou de outra) continuam "expirada".
    expect(await problemCode(await get(test, cookie, '/processes'))).toBe('SESSION_EXPIRED');
  });

  it('401 de novo com o token recém-renovado → encerramento REFRESH_FAILED', async () => {
    const test = createTestRuntime();
    const { cookie, record } = await signIn(test);
    test.clock.now += 1_000;
    test.api.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await get(test, cookie, '/processes');
    expect(await problemCode(response)).toBe('SESSION_EXPIRED');
    expect(test.store.endings()).toMatchObject([{ key: record.key, reason: 'REFRESH_FAILED' }]);
  });
});

describe('trava de renovação entre réplicas (RN-IAM-25)', () => {
  function record(now: number): SessionRecord {
    return {
      key: hashSessionId('replicas'),
      userId: 'u',
      subject: 'sub',
      displayName: 'Cláudia',
      activeTenantId: null,
      membershipId: null,
      memberships: [],
      tokens: { ...newTokens(now - 300_000, 'antigo'), accessTokenExpiresAt: now + 10_000 },
      amr: ['pwd'],
      authTime: null,
      firstLogin: false,
      ip: null,
      userAgentHash: null,
      createdAt: now,
      lastSeenAt: now,
      idleMinutes: 30,
      idleExpiresAt: now + 30 * MINUTE,
      absoluteExpiresAt: now + 12 * 60 * MINUTE,
    };
  }

  function identity(refresh: IdentityProvider['refresh']): IdentityProvider {
    return {
      kind: 'oidc',
      beginLogin: () => Promise.reject(new Error('não usado')),
      completeLogin: () => Promise.resolve({ ok: false, reason: 'PROVIDER_ERROR' }),
      refresh,
      revokeRefreshToken: () => Promise.resolve('skipped'),
      endSessionUrl: () => Promise.resolve(null),
    };
  }

  it('a réplica sem a trava espera o token novo da outra, sem chamar o IdP', async () => {
    const store = new MemorySessionStore();
    const now = Date.now();
    const session = record(now);
    await store.create(session, 10);
    let release: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<RefreshResult>((resolve) => {
          release = () => {
            resolve({ kind: 'ok', tokens: newTokens(now, 'novo') });
          };
        }),
    );
    const other = vi.fn(() => Promise.resolve<RefreshResult>({ kind: 'transient' }));
    const replicaA = new SessionService(store, identity(slow), { now: () => now });
    const replicaB = new SessionService(store, identity(other), {
      now: () => now,
      sleep: async () => {
        release?.();
        await Promise.resolve();
      },
    });
    const first = replicaA.ensureFreshToken(session);
    await vi.waitFor(() => {
      expect(slow).toHaveBeenCalled();
    });
    const second = await replicaB.ensureFreshToken(session);
    expect(await first).toMatchObject({ status: 'ok' });
    expect(second).toMatchObject({
      status: 'ok',
      record: { tokens: { accessToken: 'access-novo' } },
    });
    expect(other).not.toHaveBeenCalled();
  });

  it('espera esgotada (5 s): segue com o token ainda válido; vencido → indisponível', async () => {
    const store = new MemorySessionStore();
    let now = Date.now();
    const session = record(now);
    await store.create(session, 10);
    await store.acquireRefreshLock(session.key, 60_000);
    const sleep = vi.fn(() => Promise.resolve());
    const service = new SessionService(
      store,
      identity(() => Promise.resolve({ kind: 'transient' })),
      { now: () => now, sleep },
    );
    expect(await service.ensureFreshToken(session)).toEqual({ status: 'ok', record: session });
    expect(sleep).toHaveBeenCalledTimes(REFRESH_WAIT_MS / 100);
    now += 20_000;
    expect(await service.ensureFreshToken(session)).toEqual({ status: 'unavailable' });
  });

  it('sessão encerrada durante a espera: logout → ended; renovação recusada → expired', async () => {
    const store = new MemorySessionStore();
    const now = Date.now();
    const session = record(now);
    await store.create(session, 10);
    await store.acquireRefreshLock(session.key, 60_000);
    let reason: 'LOGOUT' | 'REFRESH_FAILED' = 'LOGOUT';
    const service = new SessionService(
      store,
      identity(() => Promise.resolve({ kind: 'transient' })),
      {
        now: () => now,
        sleep: () =>
          store
            .end(session, { reason, occurredAt: now, ip: null, userAgent: null })
            .then(() => undefined),
      },
    );
    expect(await service.ensureFreshToken(session)).toEqual({ status: 'ended' });
    const again = { ...session, key: hashSessionId('outra') };
    await store.create(again, 10);
    await store.acquireRefreshLock(again.key, 60_000);
    reason = 'REFRESH_FAILED';
    const failing = new SessionService(
      store,
      identity(() => Promise.resolve({ kind: 'transient' })),
      {
        now: () => now,
        sleep: () =>
          store
            .end(again, { reason, occurredAt: now, ip: null, userAgent: null })
            .then(() => undefined),
      },
    );
    expect(await failing.ensureFreshToken(again)).toEqual({ status: 'expired' });
  });

  it('com a trava, outra réplica já renovou: reaproveita sem chamar o IdP; encerrada → ended', async () => {
    const store = new MemorySessionStore();
    const now = Date.now();
    const session = record(now);
    await store.create(session, 10);
    await store.save({ ...session, tokens: newTokens(now, 'da-outra') });
    const refresh = vi.fn(() => Promise.resolve<RefreshResult>({ kind: 'transient' }));
    const service = new SessionService(store, identity(refresh), { now: () => now });
    expect(await service.ensureFreshToken(session)).toMatchObject({
      status: 'ok',
      record: { tokens: { accessToken: 'access-da-outra' } },
    });
    await store.end(session, { reason: 'LOGOUT', occurredAt: now, ip: null, userAgent: null });
    expect(await service.ensureFreshToken(session)).toEqual({ status: 'ended' });
    expect(refresh).not.toHaveBeenCalled();
  });
});
