// Redis de sessões real (Testcontainers) — US-093: a troca de instituição grava `activeTenantId`/
// `membershipId` numa escrita atômica (compare-and-set em Lua) sobre o registro mais recente; dois
// cliques simultâneos e gravações concorrentes de outros campos não corrompem a sessão.
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleAuthRequest } from '@/bff/auth-handler';
import { deriveKey } from '@/bff/crypto';
import { FAKE_PERSONAS } from '@/bff/session/fake-identity';
import { createSessionRedis } from '@/bff/session/redis-connection';
import { RedisSessionStore } from '@/bff/session/redis-store';
import { newSessionId } from '@/bff/session/session-service';
import type { SessionRecord } from '@/bff/session/types';
import { browserRequest, createTestRuntime, fakeIdentity } from '@test/support/bff';

const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };
const [MEMBERSHIP_A, MEMBERSHIP_B] = FAKE_PERSONAS.ana.memberships;

describe('Redis de sessões real: troca de instituição atômica (US-093)', () => {
  let container: StartedTestContainer;
  let redis: ReturnType<typeof createSessionRedis>;
  let appEnv = 0;

  beforeAll(async () => {
    container = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    redis = createSessionRedis(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
  });

  afterAll(async () => {
    redis.disconnect();
    await container.stop();
  });

  /** Runtime do BFF com o store Redis real (prefixo próprio por teste) e uma sessão na A. */
  async function signedIn() {
    appEnv += 1;
    const store = new RedisSessionStore(redis, {
      appEnv: `it${String(appEnv)}`,
      tokenKey: deriveKey(Buffer.alloc(32, 7), 'session-tokens'),
    });
    const test = createTestRuntime({ sessionStore: store });
    test.clock.now = Date.now();
    const persona = FAKE_PERSONAS.ana;
    const sessionId = newSessionId();
    const created = await test.runtime.sessions.create(sessionId, {
      login: {
        subject: persona.subject,
        tokens: fakeIdentity(test.clock).signAccessToken(persona.subject, ['pwd']),
        amr: ['pwd'],
        authTime: test.clock.now,
      },
      user: { id: persona.userId, displayName: persona.displayName },
      firstLogin: false,
      memberships: persona.memberships,
      ip: null,
      userAgent: null,
    });
    const record = await test.runtime.sessions.activateTenant(created.record, {
      tenantId: MEMBERSHIP_A.tenant.id,
      membershipId: MEMBERSHIP_A.membershipId,
    });
    const cookie = `${test.runtime.config.sessionCookieName}=${sessionId}`;
    return { test, store, record, cookie };
  }

  function switchTo(
    test: ReturnType<typeof createTestRuntime>,
    cookie: string,
    membershipId: string,
  ) {
    return handleAuthRequest(
      browserRequest('/api/auth/switch-tenant', {
        method: 'POST',
        headers: { ...MUTATION, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ membershipId }),
      }),
      'switch-tenant',
      test.runtime,
    );
  }

  it('[Sucesso] troca na mesma sessão: o registro no Redis passa à B, com TTL preservado', async () => {
    const { test, store, record, cookie } = await signedIn();
    const response = await switchTo(test, cookie, MEMBERSHIP_B.membershipId);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await store.get(record.key)).toMatchObject({
      activeTenantId: MEMBERSHIP_B.tenant.id,
      membershipId: MEMBERSHIP_B.membershipId,
      tokens: record.tokens,
    });
    const ttl = await redis.pttl(`cf:it${String(appEnv)}:sess:${record.key}`);
    expect(ttl).toBeGreaterThan(12 * 3_600_000);
  });

  it('[Concorrência] cliques simultâneos e gravações paralelas de outros campos: nada se perde', async () => {
    const { test, store, record, cookie } = await signedIn();
    const rotated = { ...record.tokens, accessToken: 'access-rotacionado' };
    // Dois cliques na troca + uma renovação de token e vários touches de outras requisições.
    const results = await Promise.all([
      switchTo(test, cookie, MEMBERSHIP_B.membershipId),
      switchTo(test, cookie, MEMBERSHIP_B.membershipId),
      store.update(record.key, (current: SessionRecord) => ({ ...current, tokens: rotated })),
      ...Array.from({ length: 10 }, () => test.runtime.sessions.touch(record)),
    ]);
    expect(results.slice(0, 2).map((response) => (response as Response).status)).toEqual([
      200, 200,
    ]);
    const stored = await store.get(record.key);
    expect(stored).toMatchObject({
      activeTenantId: MEMBERSHIP_B.tenant.id,
      membershipId: MEMBERSHIP_B.membershipId,
      tokens: rotated,
    });
  });

  it('[Concorrência] 50 escritas concorrentes no mesmo registro: todas aplicadas (CAS em Lua)', async () => {
    const { store, record } = await signedIn();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.update(record.key, (current) => ({
          ...current,
          memberships: [
            ...current.memberships,
            { ...MEMBERSHIP_B, membershipId: `m-${String(index)}` },
          ],
        })),
      ),
    );
    const stored = await store.get(record.key);
    expect(stored?.memberships).toHaveLength(FAKE_PERSONAS.ana.memberships.length + 50);
  });

  it('desempenho: troca completa com p95 < 1 s (Redis real, API simulada)', async () => {
    const { test, cookie } = await signedIn();
    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? MEMBERSHIP_B : MEMBERSHIP_A;
      const started = performance.now();
      const response = await switchTo(test, cookie, target.membershipId);
      durations.push(performance.now() - started);
      expect(response.status).toBe(200);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(1_000);
  });
});
