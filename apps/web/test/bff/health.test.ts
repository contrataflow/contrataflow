import { HEALTH_CHECK_FIELDS, HEALTH_OUTPUTS } from '@contrataflow/observability';
import type { HealthResponse } from '@contrataflow/observability';
import { findForbiddenLabels, installMetrics } from '@contrataflow/observability/metrics';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { GET as liveGet } from '@/app/health/live/route';
import { GET as readyGet } from '@/app/health/ready/route';
import { OidcIdentityProvider } from '@/bff/auth/oidc-provider';
import { createBffHealth, readyResponse, resetBffHealthForTests } from '@/bff/health';
import { proxyRouteLabel, recordProxyRequest } from '@/bff/metrics';
import { createBffRuntime, setBffRuntimeForTests } from '@/bff/runtime';
import { startWebMetrics } from '@/bff/telemetry';
import { loadWebHealthConfig, WebHealthConfigError } from '@/config/health';
import { createTestRuntime, testConfig } from '@test/support/bff';

/* US-085 — `/health/live`, `/health/ready` e `/metrics` do web/BFF (HLT-01..03). */

const health = { cacheTtlMs: 5_000, checkTimeoutMs: 200 };

function redis(up: boolean) {
  return {
    ping: vi.fn(() =>
      up
        ? Promise.resolve('PONG')
        : Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6380'), {
              code: 'ECONNREFUSED',
            }),
          ),
    ),
  };
}

function runtimeWith(options: { redisUp?: boolean | null; apiUp?: boolean } = {}) {
  const test = createTestRuntime();
  test.api.mockImplementation(() =>
    Promise.resolve(new Response('{}', { status: options.apiUp === false ? 503 : 200 })),
  );
  const sessionRedis = options.redisUp === null ? null : redis(options.redisUp ?? true);
  return { ...test, runtime: { ...test.runtime, sessionRedis }, sessionRedis };
}

async function body(response: Response): Promise<HealthResponse> {
  expect(response.headers.get('content-type')).toBe('application/health+json');
  return (await response.json()) as HealthResponse;
}

afterEach(() => {
  resetBffHealthForTests();
  setBffRuntimeForTests(undefined);
});

describe('readiness do BFF', () => {
  it('[Sucesso] Redis de sessões e API no ar → 200 pass; a API é sondada pelo /health/live', async () => {
    const test = runtimeWith();
    const probes = createBffHealth(test.runtime, { health, appVersion: '1.0.0+gabc' });
    const response = await readyResponse(probes);
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({ status: 'pass', serviceId: 'web', releaseId: 'abc' });
    expect(Object.keys(result.checks ?? {}).sort()).toEqual([
      'api:responseTime',
      'redis-sessions:responseTime',
    ]);
    expect(test.api.mock.calls[0]?.[0]).toBe('http://api.internal:4000/health/live');
    probes.liveness.stop();
  });

  it('[Falha de integração] Redis de sessões fora → 503 fail (crítico no web — DEC-131)', async () => {
    const test = runtimeWith({ redisUp: false });
    const probes = createBffHealth(test.runtime, { health, appVersion: '1.0.0' });
    const response = await readyResponse(probes);
    expect(response.status).toBe(503);
    const result = await body(response);
    expect(result.checks?.['redis-sessions:responseTime']?.[0]?.status).toBe('fail');
    expect(JSON.stringify(result)).not.toMatch(/10\.1\.2\.3|6380|ECONNREFUSED/);
    probes.liveness.stop();
  });

  it('[Validação] API fora é degradável → 200 warn, output só da allowlist', async () => {
    const test = runtimeWith({ apiUp: false });
    const probes = createBffHealth(test.runtime, { health, appVersion: '1.0.0' });
    const response = await readyResponse(probes);
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.status).toBe('warn');
    const api = result.checks?.['api:responseTime']?.[0];
    expect(api).toMatchObject({ status: 'warn', output: HEALTH_OUTPUTS.unavailable });
    for (const key of Object.keys(api ?? {})) expect(HEALTH_CHECK_FIELDS).toContain(key);
    probes.liveness.stop();
  });

  it('[Duplicidade] dentro de 5 s não sonda as dependências de novo', async () => {
    const test = runtimeWith();
    const probes = createBffHealth(test.runtime, { health, appVersion: '1.0.0' });
    await readyResponse(probes);
    await readyResponse(probes);
    expect(test.sessionRedis?.ping).toHaveBeenCalledTimes(1);
    expect(test.api).toHaveBeenCalledTimes(1);
    probes.liveness.stop();
  });

  it('[Concorrência] requisições simultâneas compartilham uma verificação', async () => {
    const test = runtimeWith();
    const probes = createBffHealth(test.runtime, { health, appVersion: '1.0.0' });
    const [a, b] = await Promise.all([readyResponse(probes), readyResponse(probes)]);
    expect(await a.text()).toBe(await b.text());
    expect(test.api).toHaveBeenCalledTimes(1);
    probes.liveness.stop();
  });

  it('descoberta OIDC do Authentik: degradável, warn com a idade do cache quando o refresh falha', async () => {
    let idpUp = true;
    let now = Date.parse('2026-10-14T12:00:00Z');
    const issuer = 'http://localhost:9080/application/o/contrataflow/';
    const idpFetch = vi.fn<typeof fetch>(() =>
      idpUp
        ? Promise.resolve(
            Response.json({
              issuer,
              authorization_endpoint: `${issuer}authorize/`,
              token_endpoint: `${issuer}token/`,
              jwks_uri: `${issuer}jwks/`,
              end_session_endpoint: `${issuer}end-session/`,
            }),
          )
        : Promise.reject(new TypeError('fetch failed')),
    );
    const identity = new OidcIdentityProvider({
      issuer,
      clientId: 'web',
      clientSecret: 'secret',
      scopes: 'openid',
      redirectUri: 'http://localhost:3000/api/auth/callback',
      fetch: idpFetch,
      now: () => now,
    });
    const test = createTestRuntime({ identity });
    test.api.mockImplementation(() => Promise.resolve(new Response('{}')));
    const runtime = { ...test.runtime, sessionRedis: null };
    const probes = createBffHealth(runtime, {
      health: { cacheTtlMs: 0, checkTimeoutMs: 500 },
      appVersion: '1.0.0',
    });
    const first = await body(await readyResponse(probes));
    expect(first.checks?.['authentik-discovery:cacheAge']?.[0]).toMatchObject({
      status: 'pass',
      observedValue: 0,
      observedUnit: 's',
    });

    idpUp = false;
    now += 2 * 60 * 60_000;
    await identity.warmUp();
    const second = await body(await readyResponse(probes));
    expect(second.status).toBe('warn');
    expect(second.checks?.['authentik-discovery:cacheAge']?.[0]).toMatchObject({
      status: 'warn',
      observedValue: 7_200,
      output: HEALTH_OUTPUTS.stale_cache,
    });
    probes.liveness.stop();
  });

  it('IdP fora antes de carregar a descoberta → warn (not_loaded), nunca fail', async () => {
    const identity = new OidcIdentityProvider({
      issuer: 'http://localhost:9080/application/o/contrataflow/',
      clientId: 'web',
      clientSecret: 'secret',
      scopes: 'openid',
      redirectUri: 'http://localhost:3000/api/auth/callback',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const test = createTestRuntime({ identity });
    const probes = createBffHealth(
      { ...test.runtime, sessionRedis: null },
      { health, appVersion: '1.0.0' },
    );
    const result = await body(await readyResponse(probes));
    expect(result.checks?.['authentik-discovery:cacheAge']?.[0]).toMatchObject({
      status: 'warn',
      output: HEALTH_OUTPUTS.not_loaded,
    });
    probes.liveness.stop();
  });
});

describe('rotas /health/* do Next (HLT-01/02)', () => {
  it('GET /health/live e /health/ready usam o runtime do processo', async () => {
    const test = runtimeWith({ redisUp: null });
    setBffRuntimeForTests(test.runtime);
    vi.stubEnv('APP_ENV', 'test');
    const live = liveGet();
    expect(live.status).toBe(200);
    expect((await body(live)).checks?.['eventloop:delay']?.[0]?.status).toBe('pass');
    const ready = await readyGet();
    expect(ready.status).toBe(200);
    expect((await body(ready)).serviceId).toBe('web');
    vi.unstubAllEnvs();
  });

  it('runtime real sem Redis configurado: sem o check de sessões (sessões em memória)', () => {
    const runtime = createBffRuntime(testConfig());
    expect(runtime.sessionRedis).toBeNull();
  });
});

describe('métricas do BFF (HLT-03)', () => {
  beforeAll(() => {
    installMetrics({
      serviceName: 'contrataflow-web',
      serviceVersion: 'test',
      environment: 'test',
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('[Tenant incorreto] rota agregada pelo recurso: nada do caminho bruto nem tenant', async () => {
    recordProxyRequest({
      method: 'GET',
      path: '/processes/0192f000-0000-7000-8000-000000000001',
      status: 200,
      durationSeconds: 0.12,
      upstreamSeconds: 0.1,
    });
    recordProxyRequest({ method: 'POST', path: '/x%20y', status: 503, durationSeconds: 1 });
    // Porta interna alta (o padrão 9466 pode estar em uso pelo `pnpm dev`).
    vi.stubEnv('METRICS_PORT', '59466');
    startWebMetrics();
    startWebMetrics();
    const text = await vi.waitFor(async () => {
      const response = await fetch('http://127.0.0.1:59466/metrics');
      expect(response.status).toBe(200);
      return response.text();
    });
    expect(text).toContain('http_server_request_duration_seconds_bucket{');
    expect(text).toContain('http_route="/api/v1/processes/*"');
    expect(text).toContain('http_route="/api/v1/other"');
    expect(text).toContain(
      'http_client_request_duration_seconds_count{http_response_status_code="200"} 1',
    );
    expect(text).not.toContain('0192f000');
    expect(findForbiddenLabels(text)).toEqual([]);
  });

  it('proxyRouteLabel mantém o conjunto fechado', () => {
    expect(proxyRouteLabel('/tasks')).toBe('/api/v1/tasks/*');
    expect(proxyRouteLabel('/Processes/1')).toBe('/api/v1/other');
    expect(proxyRouteLabel('/')).toBe('/api/v1/other');
  });
});

describe('configuração de health/métricas do web', () => {
  it('padrões e validação', () => {
    expect(loadWebHealthConfig({})).toEqual({
      metricsPort: 9466,
      cacheTtlMs: 5_000,
      checkTimeoutMs: null,
    });
    expect(loadWebHealthConfig({ HEALTH_CHECK_TIMEOUT_MS: '250' }).checkTimeoutMs).toBe(250);
    expect(() => loadWebHealthConfig({ METRICS_PORT: 'abc' })).toThrow(WebHealthConfigError);
  });
});
