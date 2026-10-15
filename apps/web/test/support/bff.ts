// Fábricas dos testes do BFF: configuração válida, runtime com API simulada e sessões prontas.
import { vi } from 'vitest';

import type { PasswordRecovery } from '@/bff/auth/password-recovery';
import { MemoryRateLimitCounter } from '@/bff/auth/rate-limit';
import { createBffRuntime } from '@/bff/runtime';
import type { BffRuntime } from '@/bff/runtime';
import { FAKE_PERSONAS, FakeIdentityProvider } from '@/bff/session/fake-identity';
import type { FakePersona, FakePersonaName } from '@/bff/session/fake-identity';
import { MemorySessionStore } from '@/bff/session/memory-store';
import { newSessionId } from '@/bff/session/session-service';
import type {
  IdentityProvider,
  SessionDirectory,
  SessionRecord,
  SessionStore,
} from '@/bff/session/types';
import { loadWebConfig } from '@/config/env';
import type { EnvSource, WebConfig } from '@/config/env';

import { requestUrl } from './render';

export const APP_ORIGIN = 'http://localhost:3000';
export const API_URL = 'http://api.internal:4000';
export const FAKE_KEY = 'test-only-fake-jwt-signing-key-0000000000';

export const BASE_ENV: EnvSource = {
  APP_ENV: 'test',
  APP_BASE_URL: APP_ORIGIN,
  API_INTERNAL_URL: API_URL,
  TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
  OIDC_ISSUER_URL: 'http://localhost:9080/application/o/contrataflow/',
  OIDC_AUDIENCE: 'contrataflow-web',
  OIDC_FAKE_SIGNING_KEY: FAKE_KEY,
};

export function testConfig(overrides: EnvSource = {}): WebConfig {
  return loadWebConfig({ ...BASE_ENV, ...overrides });
}

export interface TestRuntime {
  readonly runtime: BffRuntime;
  readonly store: MemorySessionStore;
  readonly api: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly clock: { now: number };
}

/** Runtime com API simulada (`api`) e relógio controlável (`clock.now`). */
export function createTestRuntime(
  options: {
    readonly identity?: IdentityProvider;
    readonly directory?: SessionDirectory;
    /** *Flow* de recuperação de senha (padrão: o fake, que volta direto a SCR-001). */
    readonly recovery?: PasswordRecovery;
    /** Store alternativo (ex.: um que falha); o `store` devolvido continua o em memória. */
    readonly sessionStore?: SessionStore;
    readonly upstreamTimeoutMs?: number;
    readonly env?: EnvSource;
  } = {},
): TestRuntime {
  const clock = { now: Date.parse('2026-10-14T12:00:00Z') };
  const store = new MemorySessionStore();
  const api = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ data: { ok: true } })));
  const config = testConfig(options.env);
  const runtime = createBffRuntime(config, {
    store: options.sessionStore ?? store,
    rateLimitCounter: new MemoryRateLimitCounter(),
    fetch: api,
    now: () => clock.now,
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.directory ? { directory: options.directory } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.upstreamTimeoutMs ? { upstreamTimeoutMs: options.upstreamTimeoutMs } : {}),
  });
  return { runtime, store, api, clock };
}

export function fakeIdentity(clock: { now: number }): FakeIdentityProvider {
  return new FakeIdentityProvider({
    signingKey: FAKE_KEY,
    issuer: BASE_ENV.OIDC_ISSUER_URL ?? '',
    audience: 'contrataflow-web',
    now: () => clock.now,
  });
}

/**
 * Cria uma sessão ativa para a pessoa (instituição ativa = a primeira utilizável) e devolve o
 * cabeçalho `Cookie` correspondente.
 */
export async function signIn(
  test: TestRuntime,
  persona: FakePersonaName = 'ana',
): Promise<{ cookie: string; record: SessionRecord }> {
  const identity = fakeIdentity(test.clock);
  const data: FakePersona = FAKE_PERSONAS[persona];
  const sessionId = newSessionId();
  const created = await test.runtime.sessions.create(sessionId, {
    login: {
      subject: data.subject,
      tokens: identity.signAccessToken(data.subject, ['pwd']),
      amr: ['pwd'],
      authTime: test.clock.now,
    },
    user: { id: data.userId, displayName: data.displayName },
    firstLogin: false,
    memberships: data.memberships,
    ip: null,
    userAgent: null,
  });
  const first = data.memberships.find((membership) => membership.usable);
  const record = first
    ? await test.runtime.sessions.activateTenant(created.record, {
        tenantId: first.tenant.id,
        membershipId: first.membershipId,
      })
    : created.record;
  return { cookie: `${test.runtime.config.sessionCookieName}=${sessionId}`, record };
}

/** Requisição do browser para o BFF (mesma origem). */
export function browserRequest(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  return new Request(`${APP_ORIGIN}${path}`, init);
}

/** Último pedido feito à API simulada. */
export function lastApiCall(api: TestRuntime['api']): { url: string; init: RequestInit } {
  const call = api.mock.calls.at(-1);
  if (!call) throw new Error('A API simulada não foi chamada.');
  const [input, init] = call;
  return { url: requestUrl(input), init: init ?? {} };
}
