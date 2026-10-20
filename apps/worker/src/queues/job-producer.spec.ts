import type { JobData, JobMeta, QueueName } from '@contrataflow/types';
import type { JobsOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { buildDeadLetterRecord, deadLetterJobId } from './dead-letter.js';
import { runWithJob } from './job-context.js';
import { MAX_PAYLOAD_BYTES, JobProducer } from './job-producer.js';
import type { QueueAddPort } from './job-producer.js';
import { DEFAULT_JOB_OPTIONS } from './queue-options.js';

const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0192f0a0-0000-7000-8000-00000000000b';
const USER = '0192f0a0-0000-7000-8000-0000000000aa';
const EVENT = '0192f0a0-0000-7000-8000-0000000000ee';

class MemoryQueues implements QueueAddPort {
  readonly added: { queue: QueueName; name: string; data: JobData<unknown>; opts: JobsOptions }[] =
    [];

  add(queue: QueueName, name: string, data: JobData<unknown>, opts: JobsOptions): Promise<void> {
    this.added.push({ queue, name, data, opts });
    return Promise.resolve();
  }
}

function activeMeta(overrides: Partial<JobMeta> = {}): JobMeta {
  return {
    schemaVersion: 1,
    tenantId: TENANT_A,
    actor: { type: 'USER', userId: USER, membershipId: null },
    correlationId: 'corr-producer-1',
    causationId: EVENT,
    enqueuedAt: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date('2026-10-15T12:30:00.000Z');

describe('JobProducer.enqueue — meta injetado do contexto (RN-FND-63/65 · DEC-164)', () => {
  it('herda tenant, ator, correlação e causa do job em execução e aplica a política padrão', async () => {
    const queues = new MemoryQueues();
    const producer = new JobProducer(queues, () => NOW);
    await runWithJob(
      { meta: activeMeta(), queue: 'notifications', jobName: 'event', jobId: EVENT },
      () =>
        producer.enqueue(
          'email',
          'send',
          { kind: 'NOTIFICATION', notificationId: 'n1' },
          { jobId: 'n1' },
        ),
    );
    expect(queues.added).toEqual([
      {
        queue: 'email',
        name: 'send',
        data: {
          meta: {
            schemaVersion: 1,
            tenantId: TENANT_A,
            actor: { type: 'USER', userId: USER, membershipId: null },
            correlationId: 'corr-producer-1',
            causationId: EVENT,
            enqueuedAt: NOW.toISOString(),
          },
          payload: { kind: 'NOTIFICATION', notificationId: 'n1' },
        },
        opts: { ...DEFAULT_JOB_OPTIONS, jobId: 'n1' },
      },
    ]);
  });

  it('fora de um job: ator SYSTEM e correlação nova — só para jobs de plataforma', async () => {
    const queues = new MemoryQueues();
    const producer = new JobProducer(queues);
    await producer.enqueue('maintenance', 'outbox-purge', {});
    const meta = queues.added[0]?.data.meta;
    expect(meta).toMatchObject({ tenantId: null, actor: { type: 'SYSTEM' }, causationId: null });
    expect(meta?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(producer.enqueue('email', 'send', {})).rejects.toThrow('exige tenant');
  });

  it('job de plataforma escolhe o tenant do filho; job de tenant não troca de tenant', async () => {
    const queues = new MemoryQueues();
    const producer = new JobProducer(queues);
    await runWithJob(
      {
        meta: activeMeta({ tenantId: null, causationId: null }),
        queue: 'deadlines',
        jobName: 'tick',
        jobId: 't',
      },
      () =>
        producer.enqueue('deadlines', 'scan-tenant', {}, { tenantId: TENANT_B, causationId: null }),
    );
    expect(queues.added[0]?.data.meta.tenantId).toBe(TENANT_B);
    await expect(
      runWithJob({ meta: activeMeta(), queue: 'notifications', jobName: 'event', jobId: 'e' }, () =>
        producer.enqueue('email', 'send', {}, { tenantId: TENANT_B }),
      ),
    ).rejects.toThrow('não troca de tenant');
  });

  it('recusa nome fora do registro (V-03) e payload acima de 16 KB (V-02)', async () => {
    const producer = new JobProducer(new MemoryQueues());
    await expect(producer.enqueue('email', 'render', {})).rejects.toThrow('fora do registro');
    const big = { ids: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    await expect(producer.enqueue('maintenance', 'daily', big)).rejects.toThrow('máximo 16384');
    await expect(producer.enqueue('maintenance', 'daily', undefined)).resolves.toBeUndefined();
  });
});

describe('dead-letter — cópia rastreável da falha final (RN-FND-67 · queues.md §11.1)', () => {
  it('jobId determinístico, mensagem sanitizada e stack truncado em 4 KB', () => {
    expect(deadLetterJobId('email', 'n1')).toBe('email.n1');
    const error = Object.assign(new Error('falhou para maria@prefeitura.gov.br'), { code: 'X1' });
    error.stack = `Error: ${'ã'.repeat(5_000)}`;
    const record = buildDeadLetterRecord(
      {
        queue: 'email',
        jobName: 'send',
        jobId: 'n1',
        attemptsMade: 5,
        enqueuedAt: Date.parse('2026-10-15T12:00:00.000Z'),
        data: { meta: null, payload: { notificationId: 'n1' } },
        meta: null,
      },
      error,
      'TRANSIENT_EXHAUSTED',
      new Date('2026-10-15T12:05:00.000Z'),
    );
    expect(record.source).toEqual({
      queue: 'email',
      jobName: 'send',
      jobId: 'n1',
      attemptsMade: 5,
      firstEnqueuedAt: '2026-10-15T12:00:00.000Z',
      failedAt: '2026-10-15T12:05:00.000Z',
    });
    expect(record.error.message).not.toContain('maria@prefeitura.gov.br');
    expect(record.error.code).toBe('X1');
    expect(Buffer.byteLength(record.error.stack ?? '', 'utf8')).toBeLessThanOrEqual(4_096);
    expect(record.error.stack).not.toContain('�');
  });

  it('erro que não é Error vira Error genérico, sem stack quando ausente', () => {
    const record = buildDeadLetterRecord(
      {
        queue: 'q',
        jobName: 'j',
        jobId: '1',
        attemptsMade: 1,
        enqueuedAt: 0,
        data: {},
        meta: null,
      },
      'texto',
      'PERMANENT',
      new Date(0),
    );
    expect(record.error).toMatchObject({ name: 'Error', message: 'texto', class: 'PERMANENT' });
    const noStack = new Error('sem');
    delete noStack.stack;
    expect(
      buildDeadLetterRecord(
        {
          queue: 'q',
          jobName: 'j',
          jobId: '1',
          attemptsMade: 1,
          enqueuedAt: 0,
          data: {},
          meta: null,
        },
        noStack,
        'SECURITY',
        new Date(0),
      ).error.stack,
    ).toBeUndefined();
  });
});
