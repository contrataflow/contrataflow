import { QUEUE_NAMES } from '@contrataflow/types';
import type { MinimalJob } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_TYPE,
  DEFAULT_JOB_OPTIONS,
  QUEUE_POLICIES,
  WORKER_DEFAULTS,
  backoffBaseOf,
  backoffStrategy,
  consumerConnection,
  exponentialJitterMs,
  jitterFraction,
  producerConnection,
  queuePrefix,
  retryDelayMs,
} from './queue-options.js';

describe('convenções das filas (DEC-163 · queues.md §2/§10.1)', () => {
  it('prefixo por ambiente e política padrão', () => {
    expect(queuePrefix('staging')).toBe('cf:staging:q');
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: BACKOFF_TYPE, delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    });
  });

  it('produtor falha rápido sem o Redis; consumidor usa comandos bloqueantes', () => {
    expect(producerConnection('redis://r:6379')).toMatchObject({
      url: 'redis://r:6379',
      enableOfflineQueue: false,
    });
    const retry = (producerConnection('redis://r') as { retryStrategy: (n: number) => number })
      .retryStrategy;
    expect([retry(1), retry(100)]).toEqual([200, 5_000]);
    expect(consumerConnection('redis://r:6379')).toMatchObject({ maxRetriesPerRequest: null });
  });

  it('backoff exponencial com equal jitter e teto de 15 min', () => {
    expect(exponentialJitterMs(1, 5_000, () => 0)).toBe(2_500);
    expect(exponentialJitterMs(1, 5_000, () => 1)).toBe(5_000);
    expect(exponentialJitterMs(4, 5_000, () => 1)).toBe(40_000);
    expect(exponentialJitterMs(30, 5_000, () => 1)).toBe(900_000);
    expect(exponentialJitterMs(0, 5_000, () => 0)).toBe(2_500);
  });

  it('estratégia dos Workers só trata o tipo próprio e respeita o delay do job', () => {
    const job = { opts: { backoff: { type: BACKOFF_TYPE, delay: 1_000 } } } as MinimalJob;
    expect(backoffStrategy(1, 'fixed')).toBe(0);
    const delay = backoffStrategy(2, BACKOFF_TYPE, undefined, job);
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThanOrEqual(2_000);
    const fallback = backoffStrategy(1, BACKOFF_TYPE);
    expect(fallback).toBeGreaterThanOrEqual(2_500);
    expect(fallback).toBeLessThanOrEqual(5_000);
  });

  it('jitter determinístico por job e tentativa: o log prevê a espera aplicada pelo BullMQ', () => {
    const job = {
      id: 'job-1',
      opts: { backoff: { type: BACKOFF_TYPE, delay: 5_000 } },
    } as MinimalJob;
    const fraction = jitterFraction('job-1', 2);
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThan(1);
    expect(jitterFraction('job-1', 2)).toBe(fraction);
    expect(jitterFraction('job-1', 3)).not.toBe(fraction);
    expect(backoffStrategy(2, BACKOFF_TYPE, undefined, job)).toBe(retryDelayMs('job-1', 2, 5_000));
    expect(backoffBaseOf({})).toBe(5_000);
    expect(backoffBaseOf({ backoff: 1_000 })).toBe(5_000);
  });

  it('política de cada fila consumida e proteção contra poison job (FA-02)', () => {
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual(
      QUEUE_NAMES.filter((name) => name !== 'dead-letter').sort(),
    );
    expect(WORKER_DEFAULTS).toEqual({
      lockDuration: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
    expect(QUEUE_POLICIES.email.limiter).toEqual({ max: 10, duration: 1_000 });
    expect(QUEUE_POLICIES['file-scan'].timeoutMs).toBe(90_000);
  });
});
