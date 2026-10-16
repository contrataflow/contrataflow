// US-097 · RN-IAM-108 — "AuthorizationService com cache quente: p95 < 5 ms por verificação": a
// decisão completa do guard (permissões efetivas do Redis real + `@RequirePermission` com MFA) para
// um vínculo com várias atribuições e escopos. O banco não entra no caminho quente (o retrato vem
// do Redis). Suíte de performance (DEC-087: medida no endurecimento, fora do CI do PR):
// `pnpm --filter @contrataflow/api test:perf`.
import { Logger } from '@nestjs/common';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthorizationService } from '#modules/access/application/authorization.service.js';
import { AUTHORIZATION_PORT } from '#shared/auth/authorization.js';
import type { AuthorizationPort } from '#shared/auth/authorization.js';
import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi, testConfig } from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { assignRole, seedDefaultRolesOf } from '../support/structure-fixtures.js';

const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
const A = FAKE_TENANTS.prefeituraA.id;
const ANA = FAKE_USERS.ana;
const MEMBERSHIP = FAKE_MEMBERSHIPS.find((m) => m.userId === ANA.id && m.tenantId === A)?.id ?? '';
const WARMUP = 50;
const SAMPLES = 1_000;
const P95_BUDGET_MS = 5;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] AuthorizationService com cache quente (US-097 · RN-IAM-108)', () => {
  let redis: StartedTestContainer;
  let api: TestApi;
  let port: AuthorizationPort;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    redis = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    api = await createTestApi({
      stores: 'redis',
      config: testConfig({
        REDIS_CACHE_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      }),
    });
    const cache = api.app.get<CacheStore>(CACHE_STORE, { strict: false });
    await vi.waitFor(async () => cache.set('cf:test:p:warmup', '1', 5), { timeout: 10_000 });
    const roles = seedDefaultRolesOf(api, A);
    for (const [key, scopeType] of [
      ['REQUISITANTE', 'OWN_DEPARTMENTS'],
      ['PLANEJAMENTO', 'TENANT'],
      ['COMPRAS', 'TENANT'],
      ['AUTORIDADE_COMPETENTE', 'TENANT'],
    ] as const) {
      const role = roles.get(key);
      if (role)
        assignRole(api, { tenantId: A, membershipId: MEMBERSHIP, roleId: role.id, scopeType });
    }
    port = api.app.get<AuthorizationPort>(AUTHORIZATION_PORT, { strict: false });
    expect(port).toBeInstanceOf(AuthorizationService);
  }, 120_000);

  afterAll(async () => {
    await api.close();
    await redis.stop();
    vi.restoreAllMocks();
  });

  /** Uma verificação como o guard faz: contexto novo, retrato do Redis, permissão HIGH com MFA. */
  const check = () =>
    runWithRequestContext({ correlationId: 'perf', ip: '', userAgent: '' }, async () => {
      updateRequestContext({
        tenantId: A,
        actor: { type: 'USER', userId: ANA.id, membershipId: MEMBERSHIP },
        amr: ['pwd', 'otp'],
      });
      const startedAt = performance.now();
      await port.authorize({
        requirement: { permission: 'APPROVAL_DECIDE', scope: 'ANY' },
        policies: [],
        params: {},
        resolvePolicy: () => Promise.reject(new Error('sem política')),
      });
      return performance.now() - startedAt;
    });

  it(`p95 < ${String(P95_BUDGET_MS)} ms por verificação`, async () => {
    for (let index = 0; index < WARMUP; index += 1) await check();
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) samples.push(await check());
    expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
  });
});
