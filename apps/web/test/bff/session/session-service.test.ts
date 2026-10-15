import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FAKE_PERSONA,
  FAKE_PERSONAS,
  FAKE_TOKEN_TTL_SECONDS,
  FakeSessionDirectory,
  findFakePersona,
  isFakePersona,
} from '@/bff/session/fake-identity';
import { MemorySessionStore } from '@/bff/session/memory-store';
import {
  MAX_SESSIONS_PER_USER,
  PENDING_SWITCH_TTL_MS,
  REFRESH_WINDOW_MS,
  SessionService,
  hashSessionId,
  hashUserAgent,
  newSessionId,
} from '@/bff/session/session-service';
import type { IdentityProvider, RefreshResult, SessionRecord } from '@/bff/session/types';
import { toShellSession } from '@/bff/session/view';
import { FAKE_KEY, createTestRuntime, fakeIdentity, signIn } from '@test/support/bff';

/** Padrões da plataforma (DEC-131): 30 min de ociosidade e 12 h de duração absoluta. */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 12 * 3_600_000;

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
    revokeRefreshToken: () => Promise.resolve('skipped' as const),
    endSessionUrl: () => Promise.resolve(null),
  };
}

const SECRETS = { state: 's', nonce: 'n', codeVerifier: 'v' };

describe('id de sessão (RN-IAM-10)', () => {
  it('opaco, 256 bits, aleatório e armazenado só como SHA-256', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionId()).not.toBe(id);
    expect(hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionId(id)).not.toContain(id);
  });

  it('user-agent guardado só como hash', () => {
    expect(hashUserAgent('Mozilla/5.0')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashUserAgent(null)).toBeNull();
  });
});

describe('SessionService', () => {
  it('cria a sessão sem instituição e a ativa depois, com as expirações padrão', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    expect(record.activeTenantId).toBe(FAKE_PERSONAS.ana.memberships[0].tenant.id);
    expect(record.membershipId).toBe(FAKE_PERSONAS.ana.memberships[0].membershipId);
    expect(record.idleExpiresAt - record.createdAt).toBe(SESSION_IDLE_MS);
    expect(record.absoluteExpiresAt - record.createdAt).toBe(SESSION_ABSOLUTE_MS);
    expect(test.store.size).toBe(1);
  });

  it('pessoa sem vínculo usável fica sem instituição ativa', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test, 'gil');
    expect(record.activeTenantId).toBeNull();
  });

  it(`no máximo ${MAX_SESSIONS_PER_USER} sessões por usuário: a mais antiga é encerrada`, async () => {
    const test = createTestRuntime();
    const first = await signIn(test);
    for (let index = 1; index < MAX_SESSIONS_PER_USER; index += 1) {
      test.clock.now += 1_000;
      await signIn(test);
    }
    expect(test.store.byUser(first.record.userId)).toHaveLength(MAX_SESSIONS_PER_USER);
    test.clock.now += 1_000;
    await signIn(test);
    expect(test.store.byUser(first.record.userId)).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(await test.store.get(first.record.key)).toBeNull();
    expect(test.store.endings().map((ending) => ending.reason)).toEqual(['SESSION_LIMIT']);
    // Outras pessoas não são afetadas.
    await signIn(test, 'bruno');
    expect(test.store.byUser(first.record.userId)).toHaveLength(MAX_SESSIONS_PER_USER);
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
                idToken: null,
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

  it('ativar instituição reaproveita a sessão e atualiza os vínculos', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const target = FAKE_PERSONAS.ana.memberships[1];
    const updated = await test.runtime.sessions.activateTenant(
      record,
      { tenantId: target.tenant.id, membershipId: target.membershipId },
      [target],
    );
    expect(updated.key).toBe(record.key);
    expect(updated.activeTenantId).toBe(target.tenant.id);
    expect(updated.memberships).toEqual([target]);
    expect(await test.store.get(record.key)).toEqual(updated);
  });

  it('step-up substitui tokens, amr e auth_time na mesma sessão', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const identity = fakeIdentity(test.clock);
    const updated = await test.runtime.sessions.replaceTokens(record, {
      subject: record.subject,
      tokens: identity.signAccessToken(record.subject, ['pwd', 'otp']),
      amr: ['pwd', 'otp'],
      authTime: test.clock.now + 1,
    });
    expect(updated.key).toBe(record.key);
    expect(updated.amr).toEqual(['pwd', 'otp']);
    expect(updated.authTime).toBe(test.clock.now + 1);
  });

  it('projeção pública nunca contém tokens nem a chave da sessão', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const view = toShellSession(record);
    expect(JSON.stringify(view)).not.toContain(record.tokens.accessToken);
    expect(JSON.stringify(view)).not.toContain(record.key);
    expect(view.activeTenant?.name).toBe('Prefeitura A');
    expect(view.memberships[0]).toEqual({
      membershipId: FAKE_PERSONAS.ana.memberships[0].membershipId,
      tenant: {
        id: FAKE_PERSONAS.ana.memberships[0].tenant.id,
        name: 'Prefeitura A',
        status: 'ACTIVE',
      },
      type: 'INTERNAL',
      expiresAt: null,
      usable: true,
    });
    expect(view.readOnly).toBe(false);
    expect(toShellSession({ ...record, activeTenantId: null }).activeTenant).toBeNull();
  });

  it('instituição em encerramento marca a sessão como somente leitura (FA-08)', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const [first] = record.memberships;
    if (!first) throw new Error('sem vínculo');
    const readOnly = toShellSession({
      ...record,
      memberships: [
        { ...first, readOnly: true, tenant: { ...first.tenant, status: 'OFFBOARDING' } },
      ],
    });
    expect(readOnly.readOnly).toBe(true);
  });
});

describe('FakeIdentityProvider e FakeSessionDirectory (FA-06)', () => {
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
    expect(tokens.idToken).toBeNull();
  });

  it('login: callback do próprio app com o state gerado; persona por nome ou sub', async () => {
    const identity = fakeIdentity({ now: Date.now() });
    const start = await identity.beginLogin({
      appOrigin: 'http://localhost:3000',
      stepUp: false,
      hint: 'davi',
    });
    const callback = new URL(start.redirectUrl);
    expect(callback.pathname).toBe('/api/auth/callback');
    expect(callback.searchParams.get('code')).toBe('davi');
    expect(callback.searchParams.get('state')).toBe(start.state);
    expect(start.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const completion = await identity.completeLogin(callback.searchParams, start);
    expect(completion.ok && completion.login.subject).toBe('sub-davi');

    const stepUp = await identity.beginLogin({
      appOrigin: 'http://x',
      stepUp: true,
      hint: 'sub-ana',
    });
    const stepUpParams = new URL(stepUp.redirectUrl).searchParams;
    expect(stepUpParams.get('code')).toBe('ana:mfa');
    const mfa = await identity.completeLogin(stepUpParams, SECRETS);
    expect(mfa.ok && mfa.login.amr).toEqual(['pwd', 'otp']);

    const fallback = await identity.beginLogin({
      appOrigin: 'http://x',
      stepUp: false,
      hint: null,
    });
    expect(new URL(fallback.redirectUrl).searchParams.get('code')).toBe(DEFAULT_FAKE_PERSONA);
  });

  it('recusa código desconhecido e erro do provedor', async () => {
    const identity = fakeIdentity({ now: Date.now() });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'mallory', state: 'a' }), SECRETS),
    ).toEqual({ ok: false, reason: 'TOKEN_INVALID' });
    expect(
      await identity.completeLogin(new URLSearchParams({ code: 'ana:root', state: 'a' }), SECRETS),
    ).toEqual({ ok: false, reason: 'TOKEN_INVALID' });
    expect(
      await identity.completeLogin(new URLSearchParams({ error: 'access_denied' }), SECRETS),
    ).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    expect(isFakePersona('toString')).toBe(false);
    expect(findFakePersona('ninguém')).toBeNull();
    expect(await identity.endSessionUrl()).toBeNull();
    expect(await identity.revokeRefreshToken()).toBe('skipped');
  });

  it('diretório fake: vínculos e instituição padrão; bloqueada; desconhecido; ativação', async () => {
    const identity = fakeIdentity({ now: Date.now() });
    const directory = new FakeSessionDirectory();
    const context = (subject: string) => ({
      accessToken: identity.signAccessToken(subject, ['pwd']).accessToken,
      sessionIdHash: 'a'.repeat(64),
      ip: null,
      userAgent: null,
      correlationId: 'c-1',
    });
    const ana = await directory.startSession(context('sub-ana'));
    expect(ana).toMatchObject({
      kind: 'ok',
      defaultTenantId: FAKE_PERSONAS.ana.memberships[0].tenant.id,
      active: null,
    });
    expect(await directory.startSession(context('sub-eva'))).toEqual({ kind: 'blocked' });
    expect(await directory.startSession(context('sub-x'))).toEqual({ kind: 'no_membership' });
    expect(
      await directory.startSession({ ...context('sub-ana'), accessToken: 'nao-e-jwt' }),
    ).toEqual({ kind: 'no_membership' });
    const activation = {
      ...context('sub-ana'),
      kind: 'start' as const,
      selection: 'MANUAL' as const,
      firstLogin: false,
      fromTenantId: null,
    };
    const target = FAKE_PERSONAS.ana.memberships[1];
    expect(
      await directory.activateTenant({ ...activation, tenantId: target.tenant.id }),
    ).toMatchObject({
      kind: 'ok',
      active: { membershipId: target.membershipId, tenantId: target.tenant.id, readOnly: false },
    });
    expect(
      await directory.activateTenant({
        ...activation,
        tenantId: '0192a000-0000-7000-8000-0000000000ff',
      }),
    ).toEqual({ kind: 'no_membership' });
    expect(
      await directory.activateTenant({
        ...activation,
        ...context('sub-eva'),
        tenantId: target.tenant.id,
      }),
    ).toEqual({ kind: 'blocked' });
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
    tokens: {
      accessToken: 'antigo',
      accessTokenExpiresAt: expiresAt,
      refreshToken: 'r',
      idToken: null,
    },
    amr: ['pwd'],
    authTime: null,
    firstLogin: false,
    ip: null,
    userAgentHash: null,
    createdAt: 0,
    lastSeenAt: 0,
    idleMinutes: 30,
    idleExpiresAt: Number.MAX_SAFE_INTEGER,
    absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
  };
  await store.create(record, 10);
  return record;
}

describe('troca de instituição sob concorrência (US-093)', () => {
  const [MEMBERSHIP_A, MEMBERSHIP_B] = FAKE_PERSONAS.ana.memberships;
  const toB = { tenantId: MEMBERSHIP_B.tenant.id, membershipId: MEMBERSHIP_B.membershipId };

  it('o touch de uma requisição em voo (registro anterior à troca) não desfaz a troca', async () => {
    const test = createTestRuntime();
    const { record: stale } = await signIn(test);
    expect(stale.activeTenantId).toBe(MEMBERSHIP_A.tenant.id);
    await test.runtime.sessions.activateTenant(stale, toB);
    test.clock.now += 1_000;
    const touched = await test.runtime.sessions.touch(stale);
    expect(touched).toMatchObject({ activeTenantId: toB.tenantId, lastSeenAt: test.clock.now });
    expect(await test.store.get(stale.key)).toMatchObject({
      activeTenantId: toB.tenantId,
      membershipId: toB.membershipId,
    });
  });

  it('a renovação de token iniciada antes da troca grava só os tokens', async () => {
    const store = new MemorySessionStore();
    const stale = await baseRecord(store, Date.now() + 10_000);
    const service = new SessionService(
      store,
      stubIdentity(() =>
        Promise.resolve({
          kind: 'ok',
          tokens: {
            accessToken: 'novo',
            accessTokenExpiresAt: Date.now() + 300_000,
            refreshToken: 'r2',
            idToken: null,
          },
        }),
      ),
    );
    await service.activateTenant(stale, toB);
    const fresh = await service.ensureFreshToken(stale);
    expect(fresh).toMatchObject({
      status: 'ok',
      record: { activeTenantId: toB.tenantId, tokens: { accessToken: 'novo' } },
    });
    expect(await store.get(stale.key)).toMatchObject({
      activeTenantId: toB.tenantId,
      tokens: { accessToken: 'novo', refreshToken: 'r2' },
    });
  });

  it('exclusive: mesma sessão em fila (mesmo após erro); sessões diferentes em paralelo', async () => {
    const service = new SessionService(
      new MemorySessionStore(),
      stubIdentity(() => Promise.reject(new Error('x'))),
    );
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = service.exclusive('s1', async () => {
      order.push('1:início');
      await gate;
      order.push('1:fim');
      throw new Error('falhou');
    });
    const second = service.exclusive('s1', () => {
      order.push('2');
      return Promise.resolve('ok');
    });
    const other = service.exclusive('s2', () => {
      order.push('outra');
      return Promise.resolve('paralela');
    });
    await expect(other).resolves.toBe('paralela');
    release();
    await expect(first).rejects.toThrow('falhou');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['1:início', 'outra', '1:fim', '2']);
  });

  it('troca pendente de step-up vale 10 min e sai ao ativar uma instituição', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const sessions = test.runtime.sessions;
    const suspended = await sessions.suspendTenantSwitch(record, { ...toB, setAsDefault: true });
    expect(sessions.pendingTenantSwitch(suspended)).toEqual({
      ...toB,
      setAsDefault: true,
      requestedAt: test.clock.now,
    });
    test.clock.now += PENDING_SWITCH_TTL_MS;
    expect(sessions.pendingTenantSwitch(suspended)).toBeNull();
    // Registro gravado antes da US-093, sem o campo.
    const { pendingTenantSwitch: _absent, ...legacy } = suspended;
    expect(sessions.pendingTenantSwitch(legacy)).toBeNull();
    const switched = await sessions.activateTenant(suspended, toB);
    expect(switched.pendingTenantSwitch).toBeNull();
    const cleared = await sessions.clearPendingTenantSwitch(
      await sessions.suspendTenantSwitch(switched, { ...toB, setAsDefault: false }),
    );
    expect(cleared.pendingTenantSwitch).toBeNull();
  });

  it('sessão encerrada no meio: nenhuma escrita recria o registro', async () => {
    const test = createTestRuntime();
    const { record } = await signIn(test);
    const sessions = test.runtime.sessions;
    await sessions.end(record, 'LOGOUT');
    const reindex = vi.spyOn(test.store, 'reindex');
    expect((await sessions.activateTenant(record, toB)).activeTenantId).toBe(toB.tenantId);
    expect(reindex).not.toHaveBeenCalled();
    await sessions.touch(record);
    await sessions.suspendTenantSwitch(record, { ...toB, setAsDefault: false });
    await sessions.clearPendingTenantSwitch(record);
    expect(await test.store.get(record.key)).toBeNull();
  });
});
