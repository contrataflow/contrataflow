import { request } from 'node:http';

import { metrics } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReadinessProbe } from './health.js';
import {
  findForbiddenLabels,
  installedMetrics,
  installMetrics,
  observeReadiness,
  startMetricsServer,
} from './metrics.js';
import type { MetricsHandle, RunningMetricsServer } from './metrics.js';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('métricas Prometheus (HLT-03)', () => {
  let handle: MetricsHandle;
  let server: RunningMetricsServer;

  beforeAll(async () => {
    handle = installMetrics({
      serviceName: 'contrataflow-api',
      serviceVersion: '1.0.0+gabc',
      environment: 'test',
    });
    server = await startMetricsServer({
      handle,
      port: 0,
      host: '127.0.0.1',
      extra: (req, res) => {
        if (req.url !== '/health/live') return false;
        res.end('ok');
        return true;
      },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.shutdown();
  });

  it('instala uma única vez por processo', () => {
    expect(installedMetrics()).toBe(handle);
    expect(
      installMetrics({ serviceName: 'contrataflow-web', serviceVersion: 'x', environment: 'y' }),
    ).toBe(handle);
  });

  it('expõe texto Prometheus válido com runtime Node, build e métricas dos módulos', async () => {
    const meter = metrics.getMeter('contrataflow-test');
    meter.createCounter('cf_test_jobs_processed').add(2, { queue: 'email', outcome: 'completed' });
    const { status, body } = await get(server.port, '/metrics');
    expect(status).toBe(200);
    for (const name of [
      'nodejs_eventloop_delay_p99_seconds',
      'process_resident_memory_bytes',
      'nodejs_heap_size_bytes{state="used"}',
      'process_cpu_seconds_total{mode="user"}',
      'process_start_time_seconds',
      'cf_build_info{version="1.0.0+gabc"} 1',
      'cf_test_jobs_processed_total{queue="email",outcome="completed"} 2',
    ]) {
      expect(body).toContain(name);
    }
    // Toda linha de amostra: nome{labels} valor — formato de exposição Prometheus.
    for (const line of body.split('\n').filter((l) => l && !l.startsWith('#'))) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? (-?[0-9.e+-]+|NaN|[+-]Inf)$/);
    }
  });

  it('[Tenant incorreto] nenhum label de tenant/usuário/e-mail sobrevive ao view', async () => {
    const meter = metrics.getMeter('contrataflow-test');
    meter.createCounter('cf_test_leaky').add(1, {
      tenantId: '0192aaaa',
      'cf.tenant.id': '0192aaaa',
      userId: 'u1',
      email: 'a@b.c',
      processId: 'p1',
      route: '/processes/:id',
    });
    const { body } = await get(server.port, '/metrics');
    expect(findForbiddenLabels(body)).toEqual([]);
    expect(body).toContain('cf_test_leaky_total{route="/processes/:id"} 1');
    expect(body).not.toContain('0192aaaa');
    expect(body).not.toContain('a@b.c');
  });

  it('readiness como métrica: cf_health_ready e o estado de cada dependência (A04)', async () => {
    observeReadiness(
      new ReadinessProbe({
        serviceId: 'api',
        appVersion: '1.0.0',
        checks: [
          {
            name: 'postgresql',
            measurement: 'responseTime',
            criticality: 'critical',
            timeoutMs: 100,
            probe: () => Promise.reject(new Error('down')),
          },
          {
            name: 'redis-cache',
            measurement: 'responseTime',
            criticality: 'degradable',
            timeoutMs: 100,
            probe: () => Promise.resolve(undefined),
          },
        ],
      }),
    );
    const { body } = await get(server.port, '/metrics');
    expect(body).toContain('cf_health_ready 0');
    expect(body).toContain('cf_health_check_status{dependency="postgresql"} 2');
    expect(body).toContain('cf_health_check_status{dependency="redis-cache"} 0');
  });

  it('rotas extras da porta interna e 404 para o resto', async () => {
    expect((await get(server.port, '/health/live')).body).toBe('ok');
    expect((await get(server.port, '/api/v1/processes')).status).toBe(404);
  });
});

describe('findForbiddenLabels (V-02)', () => {
  it('detecta labels proibidos em qualquer grafia', () => {
    const text = [
      '# HELP x y',
      'x{tenant_id="a",queue="q"} 1',
      'y{userId="u"} 1',
      'z{customer_email="e"} 1',
      'w{route="/a"} 1',
      'v 1',
    ].join('\n');
    expect(findForbiddenLabels(text)).toEqual(['customer_email', 'tenant_id', 'userId']);
  });
});
