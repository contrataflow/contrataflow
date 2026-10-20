import { currentJobLogFields } from '@contrataflow/observability';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { TenantStatus } from '#shared/auth/ports.js';
import {
  currentRequestContext,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';

import {
  assertJobTenancy,
  buildJobMeta,
  InvalidJobDataError,
  isPlatformJob,
  TenantJob,
} from './tenant-job.js';
import type { JobMeta, TenantJobRun } from './tenant-job.js';
import { TenantContextMissingError } from '../tenancy/isolation.js';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';
const USER = '0192a000-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0192a000-0000-7000-8000-0000000001a1';

const payloadSchema = z.strictObject({ notificationId: z.uuid() });

/** Handler de teste: guarda o contexto visto durante a execução. */
class RecordingJob extends TenantJob<z.infer<typeof payloadSchema>> {
  protected readonly payloadSchema = payloadSchema;
  seen: { context: RequestContext | undefined; log: unknown; meta: JobMeta } | undefined;

  protected handle(_payload: z.infer<typeof payloadSchema>, meta: JobMeta): Promise<void> {
    this.seen = { context: currentRequestContext(), log: currentJobLogFields(), meta };
    return Promise.resolve();
  }
}

function statuses(status: TenantStatus | null = 'ACTIVE') {
  return { findStatus: vi.fn(() => Promise.resolve(status)) };
}

/** Enfileira "na origem": requisição autenticada no tenant informado. */
function enqueueFrom(tenantId: string | null, queue = 'notifications', name = 'dispatch') {
  return runWithRequestContext(
    { correlationId: 'corr-origem-0001', ip: '10.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
      });
      return buildJobMeta(queue, name);
    },
  );
}

function run(meta: unknown, payload: unknown = { notificationId: USER }): TenantJobRun {
  return {
    id: 'job-1',
    queue: 'notifications',
    name: 'dispatch',
    attempt: 1,
    data: { meta, payload },
  };
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contexto de tenant em jobs (US-100 · FA-03 · RN-TEN-31)', () => {
  it('[Sucesso] o produtor grava o JobMeta a partir do contexto (nunca à mão)', async () => {
    const meta = await enqueueFrom(B);
    expect(meta).toMatchObject({
      schemaVersion: 1,
      tenantId: B,
      actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
      correlationId: 'corr-origem-0001',
      causationId: null,
    });
    expect(Date.parse(meta.enqueuedAt)).not.toBeNaN();
  });

  it('[Sucesso] o worker restaura tenant, ator e correlação da origem antes do handler', async () => {
    const meta = await enqueueFrom(B);
    const job = new RecordingJob(statuses());
    expect(currentRequestContext()).toBeUndefined();
    await expect(job.process(run(meta))).resolves.toBe('completed');
    expect(job.seen?.context).toMatchObject({
      tenantId: B,
      correlationId: 'corr-origem-0001',
      actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
      accessMode: 'FULL',
      ip: '',
    });
    expect(job.seen?.log).toMatchObject({
      tenantId: B,
      correlationId: 'corr-origem-0001',
      queue: 'notifications',
      jobName: 'dispatch',
      jobId: 'job-1',
      attempt: 1,
    });
    // Fora do job o contexto some.
    expect(currentRequestContext()).toBeUndefined();
  });

  it('job de sistema leva o nome da fila:job como ator', async () => {
    const meta = await runWithRequestContext(
      { correlationId: 'corr-sys-0001', ip: '', userAgent: '' },
      () => {
        updateRequestContext({
          tenantId: A,
          actor: { type: 'SYSTEM', userId: null, membershipId: null },
        });
        return buildJobMeta('notifications', 'dispatch');
      },
    );
    const job = new RecordingJob(statuses());
    await job.process(run(meta));
    expect(job.seen?.context?.actor).toEqual({
      type: 'SYSTEM',
      userId: null,
      membershipId: null,
      name: 'notifications:dispatch',
    });
  });

  it('[Validação] job de fila de tenant sem tenantId é rejeitado na origem e no consumo (V-09)', async () => {
    await expect(enqueueFrom(null)).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.tenant_context_missing',
        barrier: 'job',
        queue: 'notifications',
        jobName: 'dispatch',
      }),
      'security.tenant_context_missing',
    );
    const forged = { ...(await enqueueFrom(A)), tenantId: null };
    await expect(new RecordingJob(statuses()).process(run(forged))).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('jobs da lista fechada de plataforma (queues.md §9.3) aceitam tenantId nulo', async () => {
    expect(isPlatformJob('maintenance', 'outbox-purge')).toBe(true);
    expect(isPlatformJob('maintenance', 'qualquer')).toBe(false);
    expect(isPlatformJob('notifications', 'tick')).toBe(false);
    expect(() => {
      assertJobTenancy('audit-seal', 'seal-platform', null);
    }).not.toThrow();
    const meta = await runWithRequestContext(
      { correlationId: 'corr-tick-0001', ip: '', userAgent: '' },
      () => buildJobMeta('deadlines', 'tick'),
    );
    expect(meta).toMatchObject({ tenantId: null, actor: { type: 'SYSTEM', userId: null } });
  });

  it('tenant fora de ACTIVE: o job conclui sem efeito (RN-TEN-12)', async () => {
    const meta = await enqueueFrom(B);
    const job = new RecordingJob(statuses('SUSPENDED'));
    await expect(job.process(run(meta))).resolves.toBe('skipped_tenant_inactive');
    expect(job.seen).toBeUndefined();
  });

  it('meta ou payload inválidos são erros permanentes, antes de qualquer efeito', async () => {
    const meta = await enqueueFrom(B);
    const job = new RecordingJob(statuses());
    await expect(job.process(run({ ...meta, tenantId: 'abc' }))).rejects.toEqual(
      new InvalidJobDataError('meta'),
    );
    await expect(job.process(run(meta, { notificationId: 'x' }))).rejects.toEqual(
      new InvalidJobDataError('payload'),
    );
    expect(job.seen).toBeUndefined();
  });

  it('[Concorrência] jobs de tenants diferentes no mesmo processo não misturam o contexto', async () => {
    const metaA = await enqueueFrom(A);
    const metaB = await enqueueFrom(B);
    const seen: (string | null | undefined)[][] = [];
    let started = 0;
    class SlowJob extends TenantJob<z.infer<typeof payloadSchema>> {
      protected readonly payloadSchema = payloadSchema;
      protected async handle(_payload: unknown, meta: JobMeta): Promise<void> {
        // Atrasos de 0/1/2 ms alternados fazem os jobs terminarem fora da ordem de início.
        const delayMs = started++ % 3;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push([meta.tenantId, currentRequestContext()?.tenantId]);
      }
    }
    const job = new SlowJob(statuses());
    await Promise.all(
      Array.from({ length: 40 }, (_, index) => job.process(run(index % 2 === 0 ? metaA : metaB))),
    );
    expect(seen).toHaveLength(40);
    expect(seen.every(([expected, actual]) => expected === actual)).toBe(true);
  });
});
