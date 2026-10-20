import type { DeadLetterRecord } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { QueueAuditEntry, QueueAuditPort } from './platform-audit.js';
import { parseSince, runQueueCli } from './queue-cli.js';
import { QueueOperationError, QueueOperations } from './queue-operations.js';
import type { QueueOperationsDeps } from './queue-operations.js';

const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const EVENT = '0192f0a0-0000-7000-8000-0000000000ee';

interface FakeJob {
  id: string;
  name: string;
  data: unknown;
  remove(): Promise<void>;
}

class FakeQueue {
  readonly jobs = new Map<string, FakeJob>();
  readonly added: { name: string; data: unknown; jobId: string | undefined }[] = [];

  put(id: string, data: unknown): void {
    this.jobs.set(id, {
      id,
      name: 'dead-letter',
      data,
      remove: () => {
        this.jobs.delete(id);
        return Promise.resolve();
      },
    });
  }

  getJob(id: string): Promise<FakeJob | undefined> {
    return Promise.resolve(this.jobs.get(id));
  }

  getJobs(): Promise<FakeJob[]> {
    return Promise.resolve([...this.jobs.values()]);
  }

  add(name: string, data: unknown, opts: { jobId?: string }): Promise<FakeJob> {
    this.added.push({ name, data, jobId: opts.jobId });
    this.put(opts.jobId ?? name, data);
    const job = this.jobs.get(opts.jobId ?? name);
    if (!job) throw new Error('job não gravado');
    return Promise.resolve(job);
  }
}

function record(queue: string, tenantId: string | null): DeadLetterRecord {
  return {
    meta: {
      schemaVersion: 1,
      tenantId,
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
      correlationId: 'corr-dlq-00001',
      causationId: null,
      enqueuedAt: '2026-10-15T12:00:00.000Z',
    },
    source: {
      queue,
      jobName: queue === 'email' ? 'send' : 'event',
      jobId: 'n1',
      attemptsMade: 5,
      firstEnqueuedAt: '2026-10-15T12:00:00.000Z',
      failedAt: '2026-10-15T12:05:00.000Z',
    },
    data: { meta: { tenantId }, payload: { notificationId: 'n1', token: 'segredo' } },
    error: { class: 'TRANSIENT_EXHAUSTED', name: 'Error', message: 'smtp' },
  };
}

function setup(outbox?: QueueOperationsDeps['outboxTransaction']) {
  const queues = new Map<string, FakeQueue>();
  const queueOf = (name: string) => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new FakeQueue();
      queues.set(name, queue);
    }
    return queue;
  };
  const audits: QueueAuditEntry[] = [];
  const audit: QueueAuditPort = {
    record: (entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  queueOf('dead-letter').put('email.n1', record('email', TENANT_A));
  queueOf('dead-letter').put('notifications.n1', record('notifications', null));
  const operations = new QueueOperations({
    queue: queueOf as unknown as QueueOperationsDeps['queue'],
    audit,
    operator: { userId: 'op-1', name: 'Operadora' },
    ...(outbox ? { outboxTransaction: outbox } : {}),
  });
  return { operations, queueOf, audits };
}

const JUSTIFICATION = { ticket: 'OPS-42', reason: 'SMTP voltou ao ar' };

describe('operações auditadas da CLI (FA-04 · queues.md §11.2)', () => {
  it('lista e filtra a dead-letter; detalhe sai redigido', async () => {
    const { operations } = setup();
    expect((await operations.listDeadLetters()).map((item) => item.id)).toEqual([
      'email.n1',
      'notifications.n1',
    ]);
    expect(await operations.listDeadLetters({ queue: 'email' })).toEqual([
      {
        id: 'email.n1',
        queue: 'email',
        jobName: 'send',
        tenantId: TENANT_A,
        errorClass: 'TRANSIENT_EXHAUSTED',
        errorName: 'Error',
        attempts: 5,
        failedAt: '2026-10-15T12:05:00.000Z',
      },
    ]);
    expect(await operations.listDeadLetters({ tenantId: 'x' })).toEqual([]);
    expect(JSON.stringify(await operations.showDeadLetter('email.n1'))).not.toContain('segredo');
    await expect(operations.showDeadLetter('nada')).rejects.toBeInstanceOf(QueueOperationError);
  });

  it('retry reenfileira na fila de origem com jobId .r<n>, tira da DLQ e audita no tenant', async () => {
    const { operations, queueOf, audits } = setup();
    queueOf('email').put('n1.r1', {});
    await expect(operations.retryDeadLetter('email.n1', JUSTIFICATION)).resolves.toBe('n1.r2');
    expect(queueOf('email').added).toEqual([
      { name: 'send', data: record('email', TENANT_A).data, jobId: 'n1.r2' },
    ]);
    expect(await queueOf('dead-letter').getJob('email.n1')).toBeUndefined();
    expect(audits[0]).toMatchObject({
      action: 'dead_letter.retry',
      result: 'SUCCESS',
      actorUserId: 'op-1',
      tenantId: TENANT_A,
      metadata: { actorType: 'PLATFORM_OPERATOR', ticket: 'OPS-42', retriedJobId: 'n1.r2' },
    });
  });

  it('descarte exige justificativa e audita; job ausente → NOT_FOUND', async () => {
    const { operations, audits } = setup();
    await expect(
      operations.discardDeadLetter('notifications.n1', { ticket: '', reason: '' }),
    ).rejects.toThrow('--ticket');
    await operations.discardDeadLetter('notifications.n1', JUSTIFICATION);
    expect(audits[0]).toMatchObject({ action: 'dead_letter.discard', tenantId: null });
    await expect(operations.discardDeadLetter('notifications.n1', JUSTIFICATION)).rejects.toThrow(
      'não está',
    );
    await expect(operations.retryDeadLetter('nada', JUSTIFICATION)).rejects.toThrow('não está');
  });

  it('outbox:republish devolve FAILED a PENDING e audita outbox.republish', async () => {
    const sqls: string[] = [];
    const transaction = <T>(work: (client: SqlClient) => Promise<T>): Promise<T> =>
      work({
        query: (sql: string, params: readonly unknown[] = []) => {
          sqls.push(sql);
          const rows =
            params[0] === EVENT ? [{ tenant_id: TENANT_A, event_type: 'ProcessCreated' }] : [];
          return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
        },
      });
    const { operations, audits } = setup(transaction);
    await operations.republishOutboxEvent(EVENT, JUSTIFICATION);
    expect(sqls[0]).toContain("status = 'FAILED'");
    expect(audits[0]).toMatchObject({
      action: 'outbox.republish',
      tenantId: TENANT_A,
      entityId: EVENT,
    });
    await expect(operations.republishOutboxEvent('outro', JUSTIFICATION)).rejects.toThrow(
      'não FAILED',
    );
    await expect(setup().operations.republishOutboxEvent(EVENT, JUSTIFICATION)).rejects.toThrow(
      'DATABASE_URL_RELAY',
    );
  });
});

describe('runQueueCli', () => {
  function output() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  }

  it('executa os comandos e devolve o código de saída', async () => {
    const { operations } = setup();
    const o = output();
    expect(
      await runQueueCli(['dlq:list', '--queue', 'email', '--limit', '10'], operations, o.io),
    ).toBe(0);
    expect(JSON.parse(o.out[0] ?? '[]')).toHaveLength(1);
    expect(await runQueueCli(['dlq:show', 'email.n1'], operations, o.io)).toBe(0);
    expect(
      await runQueueCli(
        ['dlq:retry', 'email.n1', '--ticket', 'OPS-1', '--reason', 'voltou ao ar'],
        operations,
        o.io,
      ),
    ).toBe(0);
    expect(
      await runQueueCli(
        ['dlq:discard', 'notifications.n1', '--ticket', 'OPS-1', '--reason', 'obsoleto!'],
        operations,
        o.io,
      ),
    ).toBe(0);
    expect(o.out.slice(2)).toEqual([
      '{"retriedJobId":"n1.r1"}',
      '{"discarded":"notifications.n1"}',
    ]);
  });

  it('dlq:list --since e retry em massa com --dry-run', async () => {
    const { operations, queueOf, audits } = setup();
    const o = output();
    expect(
      await runQueueCli(['dlq:list', '--since', '2026-10-15T12:06:00Z'], operations, o.io),
    ).toBe(0);
    expect(o.out[0]).toBe('[]');
    const bulk = [
      'dlq:retry',
      '--queue',
      'email',
      '--since',
      '2026-10-15T00:00:00Z',
      '--ticket',
      'INC-9',
      '--reason',
      'SMTP voltou',
    ];
    expect(await runQueueCli([...bulk, '--dry-run'], operations, o.io)).toBe(0);
    expect(o.out[1]).toBe('{"dryRun":true,"ids":["email.n1"]}');
    expect(queueOf('email').added).toEqual([]);
    expect(await runQueueCli(bulk, operations, o.io)).toBe(0);
    expect(o.out[2]).toBe('{"dryRun":false,"ids":["email.n1"]}');
    expect(audits.map((entry) => entry.action)).toEqual(['dead_letter.retry']);
    expect(await runQueueCli(['dlq:retry', '--queue', 'email'], operations, o.io)).toBe(2);
    expect(await runQueueCli(['dlq:list', '--since', 'ontem'], operations, o.io)).toBe(1);
  });

  it('parseSince aceita relativo e ISO', () => {
    const now = new Date('2026-10-15T12:00:00.000Z');
    expect(parseSince('30m', now).toISOString()).toBe('2026-10-15T11:30:00.000Z');
    expect(parseSince('1h', now).toISOString()).toBe('2026-10-15T11:00:00.000Z');
    expect(parseSince('2d', now).toISOString()).toBe('2026-10-13T12:00:00.000Z');
    expect(parseSince('2026-10-01T00:00:00Z').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('erros de uso e de operação', async () => {
    const { operations } = setup();
    const o = output();
    expect(await runQueueCli([], operations, o.io)).toBe(2);
    expect(await runQueueCli(['dlq:show'], operations, o.io)).toBe(2);
    expect(await runQueueCli(['dlq:list', '--nope'], operations, o.io)).toBe(2);
    expect(await runQueueCli(['outbox:republish'], operations, o.io)).toBe(2);
    expect(
      await runQueueCli(
        ['dlq:discard', 'x', '--ticket', 'T1', '--reason', 'motivo'],
        operations,
        o.io,
      ),
    ).toBe(1);
    expect(
      await runQueueCli(
        ['outbox:republish', '--id', EVENT, '--ticket', 'T1', '--reason', 'motivo'],
        operations,
        o.io,
      ),
    ).toBe(1);
    expect(o.err.at(-1)).toContain('INVALID_ARGUMENT');
  });
});
