import type { JobMeta } from '@contrataflow/types';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import { CircuitBreaker } from './circuit-breaker.js';
import { currentJob } from './job-context.js';
import {
  DependencyUnavailableError,
  ExpectedDuplicateError,
  PermanentJobError,
} from './job-errors.js';
import { DEPENDENCY_PAUSE_MS, jobMetaOf, runJob } from './run-job.js';
import type { JobHandler, JobHandlerContext, RunJobDeps, RunnableJob } from './run-job.js';
import { MemoryDeadLetter, RecordingQueueMetrics } from './testing.js';

const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';

function meta(overrides: Partial<JobMeta> = {}): JobMeta {
  return {
    schemaVersion: 1,
    tenantId: TENANT_A,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'corr-run-job-1',
    causationId: null,
    enqueuedAt: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: 'job-1',
    name: 'event',
    queueName: 'notifications',
    data: { meta: meta(), payload: { id: 'x' } },
    attemptsMade: 0,
    opts: { attempts: 5, backoff: { type: 'cf-exponential-jitter', delay: 5_000 } },
    timestamp: Date.parse('2026-10-15T12:00:00.000Z'),
    processedOn: Date.parse('2026-10-15T12:00:01.000Z'),
    ...overrides,
  };
}

function handler(
  handle: (
    payload: { id: string },
    context: JobHandlerContext,
  ) => Promise<'completed' | 'skipped' | undefined>,
  extra: Partial<JobHandler<{ id: string }>> = {},
): JobHandler<{ id: string }> {
  return {
    queue: 'notifications',
    name: 'event',
    payloadSchema: z.strictObject({ id: z.string() }),
    handle,
    ...extra,
  };
}

/** Banco fake: registra o `app.tenant_id` de cada transação. */
function fakeDatabase(): WorkerDatabase & { tenants: (string | null)[] } {
  const tenants: (string | null)[] = [];
  const client: SqlClient = {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  };
  return {
    tenants,
    tenantTransaction: (tenantId, work) => {
      tenants.push(tenantId);
      return work(client);
    },
    platformTransaction: (work) => {
      tenants.push(null);
      return work(client);
    },
    withAdvisoryLock: async (_key, work) => ({ acquired: true, result: await work() }),
    close: () => Promise.resolve(),
  };
}

function deps(overrides: Partial<RunJobDeps> = {}) {
  const deadLetter = new MemoryDeadLetter();
  const metrics = new RecordingQueueMetrics();
  const pauses: number[] = [];
  const value: RunJobDeps = {
    deadLetter,
    metrics,
    timeoutMs: 1_000,
    postpone: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    now: () => new Date('2026-10-15T12:00:02.000Z'),
    ...overrides,
  };
  return { deps: value, deadLetter, metrics, pauses };
}

describe('runJob — contrato comum de consumo (RN-FND-64/66/67 · queues.md §9.2)', () => {
  it('[Sucesso] abre o contexto do tenant e a TenantTransaction e conta outcome=completed', async () => {
    const database = fakeDatabase();
    const { deps: d, metrics } = deps({ database });
    let seen: unknown;
    const result = await runJob(
      job(),
      handler(async (_payload, context) => {
        seen = currentJob();
        await context.tenantTransaction(() => Promise.resolve());
        expect(context.attempt).toBe(1);
        return undefined;
      }),
      d,
    );
    expect(result).toBe('completed');
    expect(database.tenants).toEqual([TENANT_A]);
    expect(seen).toMatchObject({
      meta: { tenantId: TENANT_A },
      queue: 'notifications',
      jobId: 'job-1',
    });
    expect(metrics.processed).toEqual([
      { queue: 'notifications', jobName: 'event', outcome: 'completed' },
    ]);
    expect(metrics.waits).toEqual([1_000]);
  });

  it('[Validação] job sem tenantId fora da lista de plataforma: não recuperável + cópia na DLQ', async () => {
    const { deps: d, deadLetter, metrics } = deps();
    const handle = vi.fn(() => Promise.resolve(undefined));
    const run = runJob(
      job({ data: { meta: meta({ tenantId: null }), payload: { id: 'x' } } }),
      handler(handle),
      d,
    );
    await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(run).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
    expect(handle).not.toHaveBeenCalled();
    const record = deadLetter.records.get('notifications.job-1');
    expect(record).toMatchObject({
      meta: { tenantId: null },
      source: { queue: 'notifications', jobName: 'event', jobId: 'job-1', attemptsMade: 1 },
      error: { class: 'SECURITY', code: 'TENANT_CONTEXT_REQUIRED' },
    });
    expect(metrics.outcomes('notifications')).toEqual(['failed']);
  });

  it('job de plataforma da lista fechada aceita tenantId nulo e não abre TenantTransaction', async () => {
    const database = fakeDatabase();
    const { deps: d } = deps({ database });
    const tick: JobHandler<Record<string, never>> = {
      queue: 'deadlines',
      name: 'tick',
      payloadSchema: z.strictObject({}),
      handle: async (_payload, context) => {
        await context.platformTransaction(() => Promise.resolve());
        await expect(context.tenantTransaction(() => Promise.resolve())).rejects.toThrow(
          'transação de tenant sem tenantId',
        );
        return 'completed';
      },
    };
    await expect(
      runJob(
        job({
          name: 'tick',
          queueName: 'deadlines',
          data: { meta: meta({ tenantId: null }), payload: {} },
        }),
        tick,
        d,
      ),
    ).resolves.toBe('completed');
    expect(database.tenants).toEqual([null]);
  });

  it('acceptsPlatformContext libera tenant nulo só para o payload declarado', async () => {
    const { deps: d } = deps();
    const accepts = handler(() => Promise.resolve(undefined), {
      acceptsPlatformContext: (payload) => payload.id === 'platform',
    });
    await expect(
      runJob(
        job({ data: { meta: meta({ tenantId: null }), payload: { id: 'platform' } } }),
        accepts,
        d,
      ),
    ).resolves.toBe('completed');
    await expect(
      runJob(
        job({ data: { meta: meta({ tenantId: null }), payload: { id: 'tenant' } } }),
        accepts,
        d,
      ),
    ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
  });

  it('job de tenant não acessa a transação de plataforma', async () => {
    const { deps: d } = deps({ database: fakeDatabase() });
    const run = runJob(
      job(),
      handler(async (_payload, context) => {
        await context.platformTransaction(() => Promise.resolve());
        return undefined;
      }),
      d,
    );
    await expect(run).rejects.toThrow('PLATFORM_CONTEXT_FORBIDDEN');
  });

  it('meta ou payload inválidos e nome sem handler: permanentes, com cópia na DLQ', async () => {
    const { deps: d, deadLetter } = deps();
    const ok = handler(() => Promise.resolve(undefined));
    await expect(runJob(job({ id: 'a', data: { payload: { id: 'x' } } }), ok, d)).rejects.toThrow(
      'INVALID_JOB_META',
    );
    await expect(
      runJob(job({ id: 'b', data: { meta: meta(), payload: { other: 1 } } }), ok, d),
    ).rejects.toThrow('INVALID_JOB_PAYLOAD');
    await expect(runJob(job({ id: 'c', name: 'unknown' }), ok, d)).rejects.toThrow(
      'JOB_NOT_REGISTERED',
    );
    await expect(runJob(job({ id: 'd', data: null }), ok, d)).rejects.toThrow('INVALID_JOB_META');
    expect([...deadLetter.records.keys()]).toEqual([
      'notifications.a',
      'notifications.b',
      'notifications.c',
      'notifications.d',
    ]);
    expect(deadLetter.records.get('notifications.a')?.meta).toBeNull();
    expect(deadLetter.records.get('notifications.b')?.error.class).toBe('PERMANENT');
  });

  it('[Duplicidade] reentrega absorvida: o handler verifica o estado e conclui sem efeito', async () => {
    const { deps: d, metrics } = deps();
    const status = new Map([['N1', 'SENT']]);
    const sent: string[] = [];
    const email = handler((payload) => {
      if (status.get(payload.id) !== 'PENDING') return Promise.resolve('skipped');
      sent.push(payload.id);
      return Promise.resolve(undefined);
    });
    const redelivered = job({ data: { meta: meta(), payload: { id: 'N1' } } });
    await expect(runJob(redelivered, email, d)).resolves.toBe('skipped');
    expect(sent).toEqual([]);
    expect(metrics.outcomes('notifications')).toEqual(['skipped']);

    // 23505 da chave de idempotência também é sucesso silencioso.
    const unique = handler(() => Promise.reject(new ExpectedDuplicateError()));
    await expect(runJob(job(), unique, d)).resolves.toBe('duplicate');
  });

  it('[Falha de integração] dependência fora adia o job sem consumir tentativa', async () => {
    const { deps: d, deadLetter, pauses, metrics } = deps();
    const render = handler(() => Promise.reject(new DependencyUnavailableError('gotenberg')));
    await expect(runJob(job({ attemptsMade: 4 }), render, d)).rejects.toBeInstanceOf(DelayedError);
    expect(pauses).toEqual([DEPENDENCY_PAUSE_MS]);
    expect(deadLetter.records.size).toBe(0);
    expect(metrics.outcomes('notifications')).toEqual(['delayed']);
  });

  it('[Falha de banco] PostgreSQL fora: transitório; com o breaker aberto, pausa sem tentativa', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const database = fakeDatabase();
    database.tenantTransaction = () => Promise.reject(refused);
    const databaseBreaker = new CircuitBreaker({ dependency: 'postgres', failureThreshold: 2 });
    const { deps: d, metrics, pauses } = deps({ database, databaseBreaker });
    const touch = handler(async (_payload, context) => {
      await context.tenantTransaction(() => Promise.resolve());
      return undefined;
    });
    await expect(runJob(job({ id: 'p1' }), touch, d)).rejects.toBe(refused);
    expect(metrics.retries).toEqual([{ queue: 'notifications', errorClass: 'TRANSIENT' }]);
    await expect(runJob(job({ id: 'p2' }), touch, d)).rejects.toBe(refused);
    expect(databaseBreaker.state).toBe('OPEN');
    await expect(runJob(job({ id: 'p3' }), touch, d)).rejects.toBeInstanceOf(DelayedError);
    expect(pauses).toEqual([DEPENDENCY_PAUSE_MS]);
    expect(metrics.outcomes('notifications')).toEqual(['retried', 'retried', 'delayed']);
  });

  it('transitório esgotado vai para a DLQ ANTES de relançar; timeout vira TIMEOUT', async () => {
    const order: string[] = [];
    const deadLetter = new MemoryDeadLetter();
    const parking = {
      park: async (id: string, record: Parameters<MemoryDeadLetter['park']>[1]) => {
        order.push('park');
        await deadLetter.park(id, record);
      },
    };
    const { deps: d } = deps({ deadLetter: parking });
    const boom = new TypeError('falhou');
    const run = runJob(
      job({ attemptsMade: 4 }),
      handler(() => Promise.reject(boom)),
      d,
    ).catch((error: unknown) => {
      order.push('rethrow');
      throw error;
    });
    await expect(run).rejects.toBe(boom);
    expect(order).toEqual(['park', 'rethrow']);
    expect(deadLetter.records.get('notifications.job-1')?.error).toMatchObject({
      class: 'TRANSIENT_EXHAUSTED',
      name: 'TypeError',
    });

    const slow = handler(
      (_payload, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve(undefined);
          });
        }),
    );
    const { deps: quick, deadLetter: timeouts } = deps({ timeoutMs: 20 });
    await expect(runJob(job({ attemptsMade: 4, id: 't' }), slow, quick)).rejects.toThrow('timeout');
    expect(timeouts.records.get('notifications.t')?.error.class).toBe('TIMEOUT');
  });

  it('retry registra worker.job_retried com o nextAttemptAt determinístico', async () => {
    const { deps: d, deadLetter, metrics } = deps();
    await expect(
      runJob(
        job({ attemptsMade: 1 }),
        handler(() => Promise.reject(new Error('x'))),
        d,
      ),
    ).rejects.toThrow('x');
    expect(deadLetter.records.size).toBe(0);
    expect(metrics.retries).toHaveLength(1);
  });

  it('tenant fora de ACTIVE: job de negócio conclui sem efeito; housekeeping roda em SUSPENDED', async () => {
    const tenants = { findStatus: vi.fn(() => Promise.resolve('SUSPENDED')) };
    const { deps: d, metrics } = deps({ tenants });
    const handle = vi.fn(() => Promise.resolve(undefined));
    await expect(runJob(job(), handler(handle), d)).resolves.toBe('skipped');
    expect(handle).not.toHaveBeenCalled();
    await expect(runJob(job(), handler(handle, { runsForSuspendedTenant: true }), d)).resolves.toBe(
      'completed',
    );
    await expect(runJob(job(), handler(handle, { ignoresTenantStatus: true }), d)).resolves.toBe(
      'completed',
    );
    tenants.findStatus.mockResolvedValue(null as never);
    await expect(runJob(job(), handler(handle, { runsForSuspendedTenant: true }), d)).resolves.toBe(
      'skipped',
    );
    expect(metrics.outcomes('notifications')).toEqual([
      'skipped',
      'completed',
      'completed',
      'skipped',
    ]);
  });

  it('sem banco configurado a TenantTransaction falha explicitamente', async () => {
    const { deps: d } = deps({ timeoutMs: 1_000 });
    const run = runJob(
      job({ attemptsMade: 4 }),
      handler(async (_payload, context) => {
        await context.tenantTransaction(() => Promise.resolve());
        return undefined;
      }),
      d,
    );
    await expect(run).rejects.toThrow('DATABASE_URL_WORKER');
  });

  it('jobMetaOf devolve o meta só quando válido', () => {
    expect(jobMetaOf({ meta: meta() })?.tenantId).toBe(TENANT_A);
    expect(jobMetaOf({ meta: { tenantId: 1 } })).toBeNull();
    expect(jobMetaOf(null)).toBeNull();
  });

  it('PermanentJobError lançado pelo handler vira UnrecoverableError com o código', async () => {
    const { deps: d, deadLetter } = deps();
    await expect(
      runJob(
        job(),
        handler(() => Promise.reject(new PermanentJobError('ENTITY_NOT_FOUND'))),
        d,
      ),
    ).rejects.toThrow('ENTITY_NOT_FOUND');
    expect(deadLetter.records.get('notifications.job-1')?.error.class).toBe('PERMANENT');
  });
});
