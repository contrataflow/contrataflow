import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FAKE_PERSONA,
  FAKE_PERSONAS,
  FAKE_TOKEN_TTL_SECONDS,
  findFakePersona,
  isFakePersona,
} from '@/bff/session/fake-identity';
import { MemorySessionStore } from '@/bff/session/memory-store';
import {
  REFRESH_WINDOW_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionService,
  defaultMembership,
  hashSessionId,
  newSessionId,
} from '@/bff/session/session-service';
import type { IdentityProvider, RefreshResult, SessionRecord } from '@/bff/session/types';
import { toShellSession } from '@/bff/session/view';
import { FAKE_KEY, createTestRuntime, fakeIdentity, signIn } from '@test/support/bff';

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function stubIdentity(refresh: () => Promise<RefreshResult>): IdentityProvider {
  return {
    kind: 'oidc',
    beginLogin: () => Promise.reject(new Error('não usado')),
    completeLogin: () => Promise.resolve({ ok: false, reason: 'PROVIDER_ERROR' }),
    refresh,
    endSessionUrl: () => null,
  };
}

describe('id de sessão', () => {
  it('opaco, aleatório e armazenado só como SHA-256', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionId()).not.toBe(id);
    expect(hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionId(id)).not.toContain(id);
  });
});

describe('SessionService', () => {
  it('cria a sessão com a instituição padrão e expirações', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    expect(record.activeTenantId).toBe(FAKE_PERSONAS.ana.memberships[0].tenant.id);
    expect(record.idleExpiresAt - record.createdAt).toBe(SESSION_IDLE_MS);
    expect(record.absoluteExpiresAt - record.createdAt).toBe(SESSION_ABSOLUTE_MS);
    expect(test.store.size).toBe(1);
  });

  it('pessoa sem vínculo usável fica sem instituição ativa', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test, 'gil');
    expect(record.activeTenantId).toBeNull();
    expect(defaultMembership([])).toBeNull();
  });

  it('expira por ociosidade e pela duração absoluta (registro apagado)', async () => {
    const test = createTestRuntime();
    const { cookie } = await signIn(test);
    const id = cookie.split('=')[1];
    test.clock.now += SESSION_IDLE_MS;
    expect(await test.runtime.sessions.lookup(id)).toEqual({ status: 'expired', reason: 'IDLE' });
    expect(test.store.size).toBe(0);

    const second = await signIn(test);
    const secondId = second.cookie.split('=')[1];
    // Toques renovam a ociosidade, nunca a absoluta.
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_MS; elapsed += SESSION_IDLE_MS - 60_000) {
      const lookup = await test.runtime.sessions.lookup(secondId);
      if (lookup.status !== 'active') break;
      const touched = await test.runtime.sessions.touch(lookup.record);
      expect(touched.idleExpiresAt).toBeLessThanOrEqual(touched.absoluteExpiresAt);
      test.clock.now += SESSION_IDLE_MS - 60_000;
    }
    expect(await test.runtime.sessions.lookup(secondId)).toEqual({
      status: 'expired',
      reason: 'ABSOLUTE',
    });
  });

  it('sem cookie ou id desconhecido → none', async () => {
    const test = createTestRuntime();
    expect(await test.runtime.sessions.lookup(null)).toEqual({ status: 'none' });
    expect(await test.runtime.sessions.lookup('desconhecido')).toEqual({ status: 'none' });
  });

  it('não renova token longe do vencimento; renova perto (≤ 60 s)', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const fresh = await test.runtime.sessions.ensureFreshToken(record);
    expect(fresh).toEqual({ status: 'ok', record });

    test.clock.now = record.tokens.accessTokenExpiresAt - REFRESH_WINDOW_MS + 1;
    const renewed = await test.runtime.sessions.ensureFreshToken(record);
    expect(renewed.status).toBe('ok');
    if (renewed.status === 'ok') {
      expect(renewed.record.tokens.accessToken).not.toBe(record.tokens.accessToken);
      expect(await test.store.get(record.key)).toEqual(renewed.record);
    }
  });

  it('uma renovação por sessão por vez (requisições concorrentes aguardam a mesma)', async () => {
    const refresh = vi.fn(
      () =>
        new Promise<RefreshResult>((resolve) => {
          setTimeout(() => {
            resolve({
              kind: 'ok',
              tokens: {
                accessToken: 'novo',
                accessTokenExpiresAt: Date.now() + 300_000,
                refreshToken: null,
              },
            });
          }, 5);
        }),
    );
    const store = new MemorySessionStore();
    const service = new SessionService(store, stubIdentity(refresh));
    const record = await baseRecord(store);
    const results = await Promise.all([
      service.ensureFreshToken(record, { force: true }),
      service.ensureFreshToken(record, { force: true }),
      service.ensureFreshToken(record, { force: true }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === 'ok')).toBe(true);
  });

  it('invalid_grant destrói a sessão (RN-IAM-26)', async () => {
    const store = new MemorySessionStore();
    const service = new SessionService(
      store,
      stubIdentity(() => Promise.resolve({ kind: 'invalid_grant' })),
    );
    const record = await baseRecord(store);
    expect(await service.ensureFreshToken(record, { force: true })).toEqual({ status: 'expired' });
    expect(store.size).toBe(0);
  });

  it('falha transitória: segue com token válido; sem token válido → unavailable', async () => {
    const store = new MemorySessionStore();
    let now = 1_000_000;
    const service = new SessionService(
      store,
      stubIdentity(() => Promise.resolve({ kind: 'transient' })),
      () => now,
    );
    const record = await baseRecord(store, now + 30_000);
    expect(await service.ensureFreshToken(record)).toEqual({ status: 'ok', record });
    expect(await service.ensureFreshToken(record, { force: true })).toEqual({
      status: 'unavailable',
    });
    now += 60_000;
    expect(await service.ensureFreshToken(record)).toEqual({ status: 'unavailable' });
    expect(store.size).toBe(1);
  });

  it('troca de tenant: switched, noop idempotente e vínculo não usável', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const tenantB = FAKE_PERSONAS.ana.memberships[1].tenant.id;
    const switched = await test.runtime.sessions.switchTenant(record, tenantB);
    expect(switched.status).toBe('switched');
    if (switched.status !== 'switched') return;
    expect(switched.record.activeTenantId).toBe(tenantB);
    expect(switched.record.membershipId).toBe(FAKE_PERSONAS.ana.memberships[1].membershipId);
    expect(switched.record.key).toBe(record.key);
    expect(await test.runtime.sessions.switchTenant(switched.record, tenantB)).toEqual({
      status: 'noop',
      record: switched.record,
    });
    expect(
      await test.runtime.sessions.switchTenant(record, '0192a000-0000-7000-8000-0000000000ff'),
    ).toEqual({
      status: 'not_usable',
    });
  });

  it('step-up substitui tokens e amr na mesma sessão', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const identity = fakeIdentity(test.clock);
    const updated = await test.runtime.sessions.replaceTokens(record, {
      userId: record.userId,
      subject: record.subject,
      displayName: record.displayName,
      memberships: record.memberships,
      tokens: identity.signAccessToken(record.subject, ['pwd', 'otp']),
      amr: ['pwd', 'otp'],
    });
    expect(updated.key).toBe(record.key);
    expect(updated.amr).toEqual(['pwd', 'otp']);
  });

  it('projeção pública nunca contém tokens', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const view = toShellSession(record);
    expect(JSON.stringify(view)).not.toContain(record.tokens.accessToken);
    expect(JSON.stringify(view)).not.toContain(record.key);
    expect(view.activeTenant?.name).toBe('Prefeitura A');
    expect(view.readOnly).toBe(false);
    expect(toShellSession({ ...record, activeTenantId: null }).activeTenant).toBeNull();
  });
});

describe('FakeIdentityProvider (FA-06)', () => {
  it('emite JWT HS256 que a API (FakeJwksProvider) aceita', () => {
    const clock = { now: Date.parse('2026-10-14T12:00:00Z') };
    const tokens = fakeIdentity(clock).signAccessToken('sub-ana', ['pwd']);
    const [header, payload, signature] = tokens.accessToken.split('.') as [string, string, string];
    const expected = createHmac('sha256', Buffer.from(FAKE_KEY, 'utf8'))
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(decodePayload(tokens.accessToken)).toMatchObject({
      iss: 'http://localhost:9080/application/o/contrataflow/',
      aud: 'contrataflow-web',
      sub: 'sub-ana',
      amr: ['pwd'],
      exp: clock.now / 1000 + FAKE_TOKEN_TTL_SECONDS,
    });
    expect(tokens.accessTokenExpiresAt).toBe(clock.now + FAKE_TOKEN_TTL_SECONDS * 1000);
  });

  it('login: callback com o mesmo state; persona por nome ou sub', async () => {
    const identity = fakeIdentity({ now: Date.now() });
    const start = await identity.beginLogin({
      appOrigin: 'http://localhost:3000',
      state: 'st',
      stepUp: false,
      hint: 'davi',
    });
    const callback = new URL(start.redirectUrl);
    expect(callback.pathname).toBe('/api/auth/callback');
    expect(callback.searchParams.get('code')).toBe('davi');
    const completion = await identity.completeLogin(callback.searchParams, start.transaction);
    expect(completion.ok && completion.identity.subject).toBe('sub-davi');

    const stepUp = await identity.beginLogin({
      appOrigin: 'http://x',
      state: 's',
      stepUp: true,
      hint: 'sub-ana',
    });
    const stepUpParams = new URL(stepUp.redirectUrl).searchParams;
    expect(stepUpParams.get('code')).toBe('ana:mfa');
    const mfa = await identity.completeLogin(stepUpParams, 's');
    expect(mfa.ok && mfa.identity.amr).toEqual(['pwd', 'otp']);

    const fallback = await identity.beginLogin({
      appOrigin: 'http://x',
      state: 's',
      stepUp: false,
      hint: null,
    });
    expect(new URL(fallback.redirectUrl).searchParams.get('code')).toBe(DEFAULT_FAKE_PERSONA);
  });

  it('recusa state divergente e código desconhecido', async () => {
    const identity = fakeIdentity({ now: Date.now() });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'ana', state: 'a' }), 'b'),
    ).toEqual({
      ok: false,
      reason: 'STATE_MISMATCH',
    });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'ana', state: 'a' }), null),
    ).toEqual({
      ok: false,
      reason: 'STATE_MISMATCH',
    });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'mallory', state: 'a' }), 'a'),
    ).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'ana:root', state: 'a' }), 'a'),
    ).toEqual({
      ok: false,
      reason: 'TOKEN_INVALID',
    });
    expect(isFakePersona('toString')).toBe(false);
    expect(findFakePersona('ninguém')).toBeNull();
    expect(identity.endSessionUrl()).toBeNull();
  });
});

async function baseRecord(
  store: MemorySessionStore,
  expiresAt = Date.now() + 300_000,
): Promise<SessionRecord> {
  const record: SessionRecord = {
    key: hashSessionId('sessao'),
    userId: 'u',
    subject: 'sub',
    displayName: 'Ana',
    activeTenantId: null,
    membershipId: null,
    memberships: [],
    tokens: { accessToken: 'antigo', accessTokenExpiresAt: expiresAt, refreshToken: 'r' },
    amr: ['pwd'],
    createdAt: 0,
    lastSeenAt: 0,
    idleExpiresAt: Number.MAX_SAFE_INTEGER,
    absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
  };
  await store.save(record);
  return record;
}
