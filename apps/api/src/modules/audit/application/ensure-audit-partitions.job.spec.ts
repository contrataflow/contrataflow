import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { InMemoryAuditSamplingStore } from '#shared/audit/sampling-store.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import { isMissingPartitionError } from '#shared/database/errors.js';

import {
  AUDIT_PARTITIONS_JOB_NAME,
  EnsureAuditPartitionsJob,
} from './ensure-audit-partitions.job.js';
import type { AuditPartitionsPort } from './ports.js';
import {
  AUDIT_PARTITIONS_INTERVAL_MS,
  AuditPartitionScheduler,
} from '../infrastructure/audit-partition.scheduler.js';
import { InMemoryAuditPartitions } from '../infrastructure/in-memory-audit.store.js';

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://cf_app:test@127.0.0.1:1/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://issuer.test/',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('partições mensais de audit_logs (FA-03 · job diário)', () => {
  it('garante o mês corrente e os dois seguintes como ator SYSTEM', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const ensure = vi.fn<AuditPartitionsPort['ensure']>(() => {
      expect(currentRequestContext()?.actor).toMatchObject({
        type: 'SYSTEM',
        name: AUDIT_PARTITIONS_JOB_NAME,
      });
      return Promise.resolve(1);
    });
    const job = new EnsureAuditPartitionsJob(config, { ensure });
    await expect(job.run()).resolves.toBe(1);
    expect(ensure).toHaveBeenCalledWith(2);
    expect(log).toHaveBeenCalledWith(
      { event: 'audit.partitions_ensured', created: 1, monthsAhead: 2 },
      'audit.partitions_ensured',
    );
  });

  it('falha vira log error (alerta), sem derrubar o processo', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const job = new EnsureAuditPartitionsJob(config, {
      ensure: () => Promise.reject(new Error('banco fora')),
    });
    await expect(job.run()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.partition_ensure_failed', errorName: 'Error' }),
      'audit.partition_ensure_failed',
    );
  });

  it('o agendador roda ao subir e a cada 24 h, e para no encerramento', () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const job = new EnsureAuditPartitionsJob(config, new InMemoryAuditPartitions());
    const run = vi.spyOn(job, 'run');
    const scheduler = new AuditPartitionScheduler(job);
    scheduler.onApplicationBootstrap();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUDIT_PARTITIONS_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    vi.advanceTimersByTime(AUDIT_PARTITIONS_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reconhece o erro de partição ausente do PostgreSQL', () => {
    const fromAdapter = {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            code: '23514',
            originalMessage: 'no partition of relation "audit_logs" found for row',
          },
        },
      },
    };
    expect(isMissingPartitionError(fromAdapter)).toBe(true);
    expect(isMissingPartitionError(new Error('violates check constraint'))).toBe(false);
  });
});

describe('amostragem em memória (mesma semântica do Redis)', () => {
  it('janela, excedente acumulado e chaves independentes', async () => {
    let now = 0;
    const store = new InMemoryAuditSamplingStore(() => now);
    const key = { tenantId: 't', subject: 'u:1', action: 'access.denied' };
    const decisions = [];
    for (let attempt = 0; attempt < 4; attempt += 1) decisions.push(await store.sample(key, 60, 2));
    expect(decisions).toEqual([
      { record: true, suppressed: 0 },
      { record: true, suppressed: 0 },
      { record: false, suppressed: 0 },
      { record: false, suppressed: 0 },
    ]);
    expect(await store.sample({ ...key, tenantId: null }, 60, 2)).toEqual({
      record: true,
      suppressed: 0,
    });
    now = 60_000;
    expect(await store.sample(key, 60, 2)).toEqual({ record: true, suppressed: 2 });
    expect(await store.sample(key, 60, 2)).toEqual({ record: true, suppressed: 0 });
  });
});
