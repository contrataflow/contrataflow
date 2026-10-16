import { HEALTH_OUTPUTS } from '@contrataflow/observability';
import type { HealthResponse } from '@contrataflow/observability';
import { findForbiddenLabels } from '@contrataflow/observability/metrics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { smtpHealthCheck, SMTP_HEALTH_CACHE_MS } from '#shared/mail/smtp-health.js';

import { startWorkerOps } from './worker-ops.js';
import type { RunningWorkerOps } from './worker-ops.js';

/* US-085 — `/health/*` e `/metrics` na porta interna do worker (HLT-01..03). */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const health = { metricsPort: 0, cacheTtlMs: 5_000, checkTimeoutMs: null };

async function get(ops: RunningWorkerOps, path: string) {
  const response = await fetch(`http://127.0.0.1:${String(ops.port)}${path}`);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    text: await response.text(),
  };
}

describe('porta interna do worker', { timeout: 20_000 }, () => {
  let ops: RunningWorkerOps | undefined;

  afterEach(async () => {
    await ops?.close();
    ops = undefined;
  });

  it('[Sucesso] sem dependências configuradas: live e ready pass, /metrics Prometheus', async () => {
    ops = await startWorkerOps({
      health,
      appVersion: '1.0.0+gabc',
      environment: 'test',
      databaseUrl: null,
      redisUrl: null,
      smtpUrl: null,
      logger,
      host: '127.0.0.1',
    });
    const live = await get(ops, '/health/live');
    expect(live.status).toBe(200);
    expect(live.type).toContain('application/health+json');
    const ready = await get(ops, '/health/ready');
    expect(JSON.parse(ready.text)).toMatchObject({ status: 'pass', serviceId: 'worker' });

    const metrics = await get(ops, '/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('nodejs_eventloop_delay_p99_seconds');
    expect(findForbiddenLabels(metrics.text)).toEqual([]);
    expect((await get(ops, '/queues')).status).toBe(404);
  });

  it('[Falha de banco] PostgreSQL e Redis de filas fora → 503 fail (ambos críticos no worker)', async () => {
    ops = await startWorkerOps({
      health: { ...health, checkTimeoutMs: 800 },
      appVersion: '1.0.0',
      environment: 'test',
      databaseUrl: 'postgresql://cf_worker:secret@127.0.0.1:1/contrataflow',
      redisUrl: 'redis://127.0.0.1:1',
      smtpUrl: null,
      logger,
      host: '127.0.0.1',
    });
    const ready = await get(ops, '/health/ready');
    expect(ready.status).toBe(503);
    const body = JSON.parse(ready.text) as HealthResponse;
    expect(body.status).toBe('fail');
    expect(body.checks?.['postgresql:responseTime']?.[0]?.status).toBe('fail');
    expect(body.checks?.['redis-queues:responseTime']?.[0]?.status).toBe('fail');
    expect(ready.text).not.toMatch(/127\.0\.0\.1|secret|cf_worker/);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'health.dependency_critical_down',
        dependency: 'postgresql',
      }),
      'dependency down',
    );
  });

  it('[Falha de integração] SMTP fora é degradável → warn 200', async () => {
    ops = await startWorkerOps({
      health: { ...health, checkTimeoutMs: 800 },
      appVersion: '1.0.0',
      environment: 'test',
      databaseUrl: null,
      redisUrl: null,
      smtpUrl: 'smtp://user:pass@127.0.0.1:1',
      logger,
      host: '127.0.0.1',
    });
    const ready = await get(ops, '/health/ready');
    expect(ready.status).toBe(200);
    const body = JSON.parse(ready.text) as HealthResponse;
    expect(body.checks?.['smtp:connection']?.[0]).toMatchObject({
      status: 'warn',
      output: HEALTH_OUTPUTS.unavailable,
    });
    expect(ready.text).not.toContain('pass@');
  });
});

describe('smtpHealthCheck (cache de 60 s)', () => {
  it('verifica uma vez por janela e reporta fail (rebaixado a warn pela criticidade)', async () => {
    let now = 0;
    let ok = false;
    const verify = vi.fn(() => (ok ? Promise.resolve(true) : Promise.reject(new Error('x'))));
    const check = smtpHealthCheck('smtp://127.0.0.1:1', 500, () => now, verify);
    expect(check.criticality).toBe('degradable');
    await expect(check.probe()).resolves.toEqual({ status: 'fail', output: 'unavailable' });
    ok = true;
    now += SMTP_HEALTH_CACHE_MS - 1;
    await expect(check.probe()).resolves.toEqual({ status: 'fail', output: 'unavailable' });
    expect(verify).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(check.probe()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
