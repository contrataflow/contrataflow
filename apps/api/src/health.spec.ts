import { EventEmitter } from 'node:events';

import {
  HEALTH_CHECK_FIELDS,
  HEALTH_OUTPUTS,
  HEALTH_RESPONSE_FIELDS,
} from '@contrataflow/observability';
import type { HealthResponse } from '@contrataflow/observability';
import { findForbiddenLabels, installMetrics } from '@contrataflow/observability/metrics';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { jwksHealthCheck } from '#modules/identity/infrastructure/jwks-health.indicator.js';
import { RedisClient } from '#modules/platform/infrastructure/redis/redis.client.js';
import { DATABASE_POOL } from '#shared/database/database-health.js';
import { resetHttpMetricsForTests, sloClassOf } from '#shared/observability/http-metrics.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { startApi } from './bootstrap.js';
import type { ShutdownProcess } from './graceful-shutdown.js';
import { createTestApi, testConfig } from '../test/support/api-test-app.js';
import type { TestApi } from '../test/support/api-test-app.js';

/*
 * US-085 — health checks e métricas da API (HLT-01..03): cenários Gherkin com a aplicação real e
 * as dependências simuladas (o PostgreSQL/Redis reais ficam no teste de integração
 * `test/health/health-ready.spec.ts`).
 */

interface FakePool {
  query: ReturnType<typeof vi.fn>;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max: number };
  end: () => Promise<void>;
}

function fakePool(query: () => Promise<unknown> = () => Promise.resolve({ rows: [] })): FakePool {
  return {
    query: vi.fn(query),
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    options: { max: 10 },
    end: () => Promise.resolve(),
  };
}

function fakeRedis(up: boolean) {
  return {
    redis: {
      ping: up
        ? () => Promise.resolve('PONG')
        : () =>
            Promise.reject(
              Object.assign(new Error('connect ECONNREFUSED 10.0.3.7:6379 (redis-prod)'), {
                code: 'ECONNREFUSED',
              }),
            ),
    },
  };
}

async function apiWith(pool: FakePool, redisUp: boolean, overrides: Record<string, string> = {}) {
  return createTestApi({
    config: testConfig({ APP_VERSION: '1.4.2+g3f9c2ab', ...overrides }),
    providers: [
      { token: DATABASE_POOL, value: pool },
      { token: RedisClient, value: fakeRedis(redisUp) },
    ],
  });
}

/** V-01: só campos da allowlist; nada de host, porta, stack ou credencial. */
function expectSafeBody(body: HealthResponse): void {
  for (const key of Object.keys(body)) expect(HEALTH_RESPONSE_FIELDS).toContain(key);
  for (const results of Object.values(body.checks ?? {})) {
    for (const result of results) {
      for (const key of Object.keys(result)) expect(HEALTH_CHECK_FIELDS).toContain(key);
      if (result.output) expect(Object.values(HEALTH_OUTPUTS)).toContain(result.output);
    }
  }
  const text = JSON.stringify(body);
  for (const forbidden of ['10.0.3.7', '127.0.0.1', '6379', 'redis-prod', 'ECONNREFUSED', 'cf_app'])
    expect(text).not.toContain(forbidden);
}

describe('US-085 — /health/ready e /health/live na API', { timeout: 30_000 }, () => {
  const apis: TestApi[] = [];
  const open = async (...args: Parameters<typeof apiWith>) => {
    const api = await apiWith(...args);
    apis.push(api);
    return api;
  };

  afterAll(async () => {
    await Promise.all(apis.map((api) => api.close()));
  });

  it('[Sucesso] dependências críticas no ar → 200 pass, fora de /api/v1 e sem autenticação', async () => {
    const api = await open(fakePool(), true);
    const response = await request(api.server).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/health+json');
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.text) as HealthResponse;
    expect(body).toMatchObject({
      status: 'pass',
      serviceId: 'api',
      version: '1.4.2',
      releaseId: '3f9c2ab',
    });
    expect(Object.keys(body.checks ?? {}).sort()).toEqual([
      'postgresql:responseTime',
      'redis-cache:responseTime',
    ]);
    expect((await request(api.server).get('/api/v1/health/ready')).status).not.toBe(200);
  });

  it('[Validação] degradável fora → 200 warn e output sem host, stack ou credencial', async () => {
    const api = await open(fakePool(), false);
    const response = await request(api.server).get('/health/ready');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as HealthResponse;
    expect(body.status).toBe('warn');
    expectSafeBody(body);
  });

  it('[Falha de banco] PostgreSQL indisponível → 503 fail com o check postgresql em fail', async () => {
    // Pool real apontando para uma porta fechada (testConfig): conexão recusada.
    const api = await createTestApi({
      providers: [{ token: RedisClient, value: fakeRedis(true) }],
    });
    apis.push(api);
    const response = await request(api.server).get('/health/ready');
    expect(response.status).toBe(503);
    const body = JSON.parse(response.text) as HealthResponse;
    expect(body.status).toBe('fail');
    expect(body.checks?.['postgresql:responseTime']?.[0]).toMatchObject({
      status: 'fail',
      output: HEALTH_OUTPUTS.unavailable,
    });
    expectSafeBody(body);
  });

  it('[Falha de integração] Redis de filas/cache fora → 200 warn; o check é warn, não fail', async () => {
    const api = await open(fakePool(), false);
    const body = JSON.parse(
      (await request(api.server).get('/health/ready')).text,
    ) as HealthResponse;
    expect(body.status).toBe('warn');
    expect(body.checks?.['redis-cache:responseTime']?.[0]?.status).toBe('warn');
    expect(body.checks?.['postgresql:responseTime']?.[0]?.status).toBe('pass');
  });

  it('[Duplicidade] chamada repetida dentro de 5 s vem do cache, sem nova verificação', async () => {
    const pool = fakePool();
    const api = await open(pool, true);
    const first = await request(api.server).get('/health/ready');
    const second = await request(api.server).get('/health/ready');
    expect(second.text).toBe(first.text);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('[Concorrência] requisições simultâneas verificam as dependências uma única vez', async () => {
    let release: () => void = () => undefined;
    const pool = fakePool(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ rows: [] });
          };
        }),
    );
    const api = await open(pool, true, { HEALTH_CACHE_TTL_MS: '5000' });
    const pending = [
      request(api.server)
        .get('/health/ready')
        .then((r) => r),
      request(api.server)
        .get('/health/ready')
        .then((r) => r),
    ];
    await vi.waitFor(() => {
      expect(pool.query).toHaveBeenCalled();
    });
    // Dá tempo de a segunda requisição chegar enquanto a primeira verificação está em curso.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await Promise.all(pending);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(a?.text).toBe(b?.text);
  });

  it('/health/live responde pass sem verificar dependência alguma', async () => {
    const pool = fakePool();
    const api = await open(pool, false);
    const response = await request(api.server).get('/health/live');
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as HealthResponse;
    expect(body.status).toBe('pass');
    expect(Object.keys(body.checks ?? {})).toEqual(['eventloop:delay']);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

describe('US-085 — /metrics (HLT-03)', { timeout: 30_000 }, () => {
  const proc = new FakeProcess();
  let running: Awaited<ReturnType<typeof startApi>>;

  beforeAll(async () => {
    installMetrics({
      serviceName: 'contrataflow-api',
      serviceVersion: 'test',
      environment: 'test',
    });
    resetHttpMetricsForTests();
    running = await startApi({
      config: testConfig(),
      port: 0,
      metricsPort: 0,
      proc,
      logger: false,
    });
  });

  afterAll(async () => {
    proc.emit('SIGTERM');
    await running.stopped;
  });

  it('[Permissão] /metrics não existe na porta pública — só na porta interna', async () => {
    const server = running.app.getHttpServer() as Parameters<typeof request>[0];
    expect((await request(server).get('/metrics')).status).toBe(404);
    const internal = await fetch(`http://127.0.0.1:${String(running.metricsPort)}/metrics`);
    expect(internal.status).toBe(200);
    expect(running.metricsPort).not.toBe(
      (running.app.getHttpServer() as { address(): { port: number } }).address().port,
    );
  });

  it('[Tenant incorreto] séries RED por rota-template e classe, sem label de tenant', async () => {
    const server = running.app.getHttpServer() as Parameters<typeof request>[0];
    const tenant = FAKE_TENANTS.prefeituraA.id;
    await request(server)
      .get('/api/v1/_internal/ping')
      .set('X-Tenant-Id', tenant)
      .set('Authorization', 'Bearer invalido');
    await request(server)
      .get(`/api/v1/processes/${FAKE_USERS.ana.id}?q=x`)
      .set('X-Tenant-Id', tenant);
    const text = await (
      await fetch(`http://127.0.0.1:${String(running.metricsPort)}/metrics`)
    ).text();
    expect(text).toContain('http_server_request_duration_seconds_bucket{');
    expect(text).toMatch(/http_route="\/api\/v1\/_internal\/ping"/);
    expect(text).toContain('slo_class="read"');
    expect(findForbiddenLabels(text)).toEqual([]);
    expect(text).not.toContain(tenant);
    expect(text).not.toContain(FAKE_USERS.ana.id);
  });
});

describe('sloClassOf (mapa rota → classe de SLO)', () => {
  it.each([
    ['GET', '/api/v1/processes/:id', false, 'read'],
    ['GET', '/api/v1/processes', true, 'search'],
    ['GET', '/api/v1/processes/:id/summary', false, 'summary'],
    ['POST', '/api/v1/processes/:id/forward', false, 'command'],
    ['POST', '/api/v1/processes', false, 'command'],
    ['DELETE', '/api/v1/attachments/:id', false, 'command'],
    ['PATCH', '/api/v1/processes/:id', false, 'write'],
    ['PUT', '/api/v1/documents/:id/sections/:key', false, 'write'],
    ['GET', '/api/v1/dashboard/overview', false, 'dashboard'],
    ['POST', '/api/v1/attachments', false, 'upload'],
    ['POST', '/api/v1/attachments/:id/confirm', false, 'upload'],
    ['POST', '/api/v1/documents/:id/upload-version', false, 'upload'],
    ['GET', '/api/v1/attachments/:id/download', false, 'upload'],
    ['GET', '/api/v1/processes/export', false, 'export'],
    ['POST', '/internal/session-events', false, 'internal'],
    ['GET', '(unmatched)', false, 'other'],
    ['OPTIONS', '/api/v1/processes', false, 'other'],
  ])('%s %s (q=%s) → %s', (method, route, q, expected) => {
    expect(sloClassOf(method, route, q)).toBe(expected);
  });
});

describe('jwksHealthCheck (FA-04)', () => {
  const verifier = (ageSeconds: number | null, lastRefreshFailed = false) => ({
    cacheState: vi.fn(() => ({ ageSeconds, lastRefreshFailed })),
    warmUp: vi.fn(() => Promise.resolve()),
  });

  it('crítico no startup: sem chaves carregadas → fail (not_loaded), após tentar carregar', async () => {
    const fake = verifier(null);
    const check = jwksHealthCheck(fake, 1_000);
    expect(check.criticality).toBe('critical');
    await expect(check.probe()).resolves.toEqual({ status: 'fail', output: 'not_loaded' });
    expect(fake.warmUp).toHaveBeenCalledTimes(1);
  });

  it('carregado: pass com a idade do cache; refresh falhando → warn com cacheAge', async () => {
    await expect(jwksHealthCheck(verifier(120), 1_000).probe()).resolves.toEqual({
      status: 'pass',
      observedValue: 120,
      observedUnit: 's',
    });
    const stale = verifier(3_600, true);
    await expect(jwksHealthCheck(stale, 1_000).probe()).resolves.toEqual({
      status: 'warn',
      observedValue: 3_600,
      observedUnit: 's',
      output: 'stale_cache',
    });
    expect(stale.warmUp).not.toHaveBeenCalled();
  });
});
