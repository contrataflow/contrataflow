import type { ApiJobFailure, ApiJobHandler, TenantJobRun } from '@contrataflow/api/jobs';
import type { JobMeta, QueueName } from '@contrataflow/types';
import type { INestApplicationContext } from '@nestjs/common';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DEPENDENCY_PAUSE_MS, runJob } from '../queues/run-job.js';
import type { RunJobDeps, RunnableJob } from '../queues/run-job.js';
import { MemoryDeadLetter, RecordingQueueMetrics } from '../queues/testing.js';

/** Falha "da API" com a classificação embutida (o classificador real é testado na API). */
class ApiFailure extends Error {
  constructor(readonly failure: ApiJobFailure) {
    super(failure.kind);
    this.name = 'ApiFailure';
  }
}

const startApiJobs = vi.fn();

// O contexto real (dist da API, banco, Redis) é da integração (test/queues/api-jobs.spec.ts).
vi.mock('@contrataflow/api/jobs', () => ({
  classifyApiJobFailure: (error: unknown): ApiJobFailure =>
    error instanceof ApiFailure ? error.failure : { kind: 'transient' },
  startApiJobs: (...args: unknown[]) => startApiJobs(...args) as unknown,
}));

const { adaptApiJob, attachApiJobs } = await import('./api-jobs.js');
const { QueueRuntime } = await import('../queues/queue.runtime.js');

const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const RENDITION = '0192f0a0-0000-7000-8000-0000000000c1';

function meta(): JobMeta {
  return {
    schemaVersion: 1,
    tenantId: TENANT_A,
    actor: { type: 'USER', userId: '0192f0a0-0000-7000-8000-0000000000e1', membershipId: null },
    correlationId: 'corr-api-jobs-1',
    causationId: null,
    enqueuedAt: '2026-10-20T12:00:00.000Z',
  };
}

/** Dublê do `TenantJob` da API: grava as execuções e devolve o resultado configurado. */
function apiJob(
  queue: QueueName,
  name: string,
  outcome: () => Promise<'completed' | 'skipped_tenant_inactive'> = () =>
    Promise.resolve('completed'),
) {
  const runs: TenantJobRun[] = [];
  const handler: ApiJobHandler = {
    queue,
    name,
    payloadSchema: z.strictObject({ id: z.uuid() }),
    process: (run) => {
      runs.push(run);
      return outcome();
    },
  };
  return { handler, runs };
}

function job(queue: QueueName, name: string, overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: RENDITION,
    name,
    queueName: queue,
    data: { meta: meta(), payload: { id: RENDITION } },
    attemptsMade: 0,
    opts: { attempts: 3, backoff: { type: 'cf-exponential-jitter', delay: 5_000 } },
    timestamp: Date.parse('2026-10-20T12:00:00.000Z'),
    ...overrides,
  };
}

function deps(overrides: Partial<RunJobDeps> = {}) {
  const deadLetter = new MemoryDeadLetter();
  const postpone = vi.fn(() => Promise.resolve());
  const findStatus = vi.fn(() => Promise.resolve('SUSPENDED'));
  return {
    deadLetter,
    postpone,
    findStatus,
    deps: {
      deadLetter,
      metrics: new RecordingQueueMetrics(),
      timeoutMs: 1_000,
      postpone,
      tenants: { findStatus },
      ...overrides,
    } satisfies RunJobDeps,
  };
}

describe('adaptApiJob — TenantJob da API → JobHandler do worker (DEC-052)', () => {
  it.each([
    ['document-render', 'render'],
    ['document-render', 'template-preview'],
    ['file-scan', 'scan'],
    ['ai-generation', 'generate'],
  ] as const)('[Sucesso] job %s/%s chega ao handler da API pelo runJob', async (queue, name) => {
    const { handler, runs } = apiJob(queue, name);
    const run = deps();
    await expect(runJob(job(queue, name), adaptApiJob(handler), run.deps)).resolves.toBe(
      'completed',
    );
    expect(runs).toEqual([
      {
        id: RENDITION,
        queue,
        name,
        attempt: 1,
        data: { meta: meta(), payload: { id: RENDITION } },
      },
    ]);
    // O status do tenant é conferido pelo próprio TenantJob (uma leitura, regra da API).
    expect(run.findStatus).not.toHaveBeenCalled();
  });

  it('tenant fora de ACTIVE: o TenantJob conclui sem efeito e o worker registra skipped', async () => {
    const { handler } = apiJob('file-scan', 'scan', () =>
      Promise.resolve('skipped_tenant_inactive'),
    );
    await expect(runJob(job('file-scan', 'scan'), adaptApiJob(handler), deps().deps)).resolves.toBe(
      'skipped',
    );
  });

  it('[Validação] payload inválido falha definitivamente sem chamar a API', async () => {
    const { handler, runs } = apiJob('file-scan', 'scan');
    const run = deps();
    const invalid = job('file-scan', 'scan', { data: { meta: meta(), payload: { id: 'x' } } });
    await expect(runJob(invalid, adaptApiJob(handler), run.deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(runs).toEqual([]);
    expect(run.deadLetter.records.get(`file-scan.${RENDITION}`)?.error).toMatchObject({
      class: 'PERMANENT',
      code: 'INVALID_JOB_PAYLOAD',
    });
  });

  it('[Falha de integração] disjuntor aberto adia o job sem consumir tentativa', async () => {
    const { handler } = apiJob('document-render', 'render', () =>
      Promise.reject(new ApiFailure({ kind: 'deferred', dependency: 'gotenberg' })),
    );
    const run = deps();
    await expect(
      runJob(job('document-render', 'render'), adaptApiJob(handler), run.deps),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(run.postpone).toHaveBeenCalledWith(DEPENDENCY_PAUSE_MS);
    expect(run.deadLetter.records.size).toBe(0);
  });

  it('falha permanente da API vai para a dead-letter sem retry', async () => {
    const { handler } = apiJob('document-render', 'render', () =>
      Promise.reject(new ApiFailure({ kind: 'permanent', code: 'RENDERER_REJECTED' })),
    );
    const run = deps();
    await expect(
      runJob(job('document-render', 'render'), adaptApiJob(handler), run.deps),
    ).rejects.toThrow(new UnrecoverableError('RENDERER_REJECTED'));
    expect(run.deadLetter.records.get(`document-render.${RENDITION}`)?.error).toMatchObject({
      class: 'PERMANENT',
      code: 'RENDERER_REJECTED',
    });
  });

  it('[Permissão] job sem tenant no contexto da API é falha de segurança', async () => {
    const { handler } = apiJob('ai-generation', 'generate', () =>
      Promise.reject(new ApiFailure({ kind: 'security', code: 'TENANT_CONTEXT_REQUIRED' })),
    );
    const run = deps();
    await expect(
      runJob(job('ai-generation', 'generate'), adaptApiJob(handler), run.deps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(run.deadLetter.records.get(`ai-generation.${RENDITION}`)?.error).toMatchObject({
      class: 'SECURITY',
    });
  });

  it('falha transitória (IA que consome tentativa, banco) relança o erro original para retry', async () => {
    const original = new Error('ECONNRESET');
    const { handler } = apiJob('ai-generation', 'generate', () => Promise.reject(original));
    const run = deps();
    await expect(
      runJob(job('ai-generation', 'generate'), adaptApiJob(handler), run.deps),
    ).rejects.toBe(original);
    expect(run.deadLetter.records.size).toBe(0);
  });
});

describe('attachApiJobs', () => {
  beforeEach(() => {
    startApiJobs.mockReset();
  });

  const config = { appEnv: 'test' } as never;

  it('sem filas no worker não sobe o contexto da API', async () => {
    const context = {
      get: () => {
        throw new Error('QueueRuntime ausente');
      },
    } as unknown as INestApplicationContext;
    await expect(attachApiJobs(context, { config, logger: false })).resolves.toBeNull();
    expect(startApiJobs).not.toHaveBeenCalled();
  });

  it('entrega os handlers ao QueueRuntime e mantém pausadas as filas sem configuração', async () => {
    const { handler } = apiJob('ai-generation', 'generate');
    const running = {
      handlers: [handler],
      paused: [{ queue: 'file-scan', name: 'scan', missing: ['CLAMAV_HOST'] }],
      close: vi.fn(),
    };
    startApiJobs.mockResolvedValue(running);
    const consume = vi.fn();
    const runtime = Object.create(QueueRuntime.prototype) as { consume: typeof consume };
    runtime.consume = consume;
    const context = { get: () => runtime } as unknown as INestApplicationContext;
    await expect(attachApiJobs(context, { config, logger: false })).resolves.toBe(running);
    expect(startApiJobs).toHaveBeenCalledWith({ config, logger: false });
    const [handlers] = consume.mock.calls[0] as [{ queue: string; name: string }[]];
    expect(handlers.map((entry) => `${entry.queue}/${entry.name}`)).toEqual([
      'ai-generation/generate',
    ]);
  });
});
