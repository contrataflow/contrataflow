import { QUEUE_JOBS, isPlatformJob } from '@contrataflow/types';
import type { JobData, QueueName } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';

import { JobHandlerRegistry, UnregisteredJobError } from './job-handler-registry.js';
import { JobProducer } from './job-producer.js';
import type { QueueAddPort } from './job-producer.js';
import { runJob } from './run-job.js';
import type { RunnableJob } from './run-job.js';
import { AuditSealTick, DeadlinesTick, MaintenanceDaily } from './scheduled-ticks.js';
import {
  SCHEDULERS,
  checkSchedulerSla,
  runScheduled,
  schedulerJobData,
  syncSchedulers,
} from './schedulers.js';
import type { SchedulerQueuePort } from './schedulers.js';
import { MemoryDeadLetter, RecordingQueueMetrics } from './testing.js';
import { DomainEventsJobHandler } from '../events/domain-events.job.js';
import { DomainEventsProcessor } from '../events/domain-events.processor.js';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.js';
import { SqlNotificationDirectory } from '../notifications/sql-notification-directory.js';

const TENANT_A = '0192f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0192f0a0-0000-7000-8000-00000000000b';
const NOW = new Date('2026-10-15T12:34:56.000Z');

class FakeSchedulerQueue implements SchedulerQueuePort {
  readonly schedulers = new Map<string, { pattern: string; tz: string; name: string }>();

  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: string },
    template: { name: string; data: JobData<object> },
  ): Promise<unknown> {
    this.schedulers.set(id, { ...repeat, name: template.name });
    return Promise.resolve();
  }

  getJobSchedulers(): Promise<{ key: string }[]> {
    return Promise.resolve([...this.schedulers.keys()].map((key) => ({ key })));
  }

  removeJobScheduler(id: string): Promise<boolean> {
    return Promise.resolve(this.schedulers.delete(id));
  }
}

describe('Job Schedulers únicos (RN-FND-68 · V-04 · queues.md §12)', () => {
  it('upsert idempotente em toda réplica e remoção de scheduler fora da definição', async () => {
    const queues = new Map<string, FakeSchedulerQueue>();
    const queueOf = (name: string) => {
      let queue = queues.get(name);
      if (!queue) {
        queue = new FakeSchedulerQueue();
        queues.set(name, queue);
      }
      return queue;
    };
    queueOf('deadlines').schedulers.set('deadlines-old', {
      pattern: '*/5 * * * *',
      tz: 'UTC',
      name: 'tick',
    });
    // Duas réplicas sobem: o resultado é o mesmo conjunto, sem duplicar padrões.
    await syncSchedulers(queueOf, NOW);
    await syncSchedulers(queueOf, NOW);
    expect([...queueOf('deadlines').schedulers.entries()]).toEqual([
      ['deadlines-tick', { pattern: '*/15 * * * *', tz: 'UTC', name: 'tick' }],
    ]);
    expect(queueOf('audit-seal').schedulers.get('audit-seal-tick')).toEqual({
      pattern: '5 * * * *',
      tz: 'UTC',
      name: 'tick',
    });
    expect(queueOf('maintenance').schedulers.get('maintenance-daily')).toEqual({
      pattern: '0 3 * * *',
      tz: 'America/Sao_Paulo',
      name: 'daily',
    });
    await expect(
      syncSchedulers(
        queueOf,
        NOW,
        [SCHEDULERS[0], SCHEDULERS[0]].filter((d) => d !== undefined),
      ),
    ).rejects.toThrow('duplicado');
  });

  it('todo scheduler gera um job de plataforma registrado, com meta de sistema', () => {
    for (const definition of SCHEDULERS) {
      expect(isPlatformJob(definition.queue, definition.jobName)).toBe(true);
      expect(schedulerJobData(definition, NOW).meta).toMatchObject({
        tenantId: null,
        actor: { type: 'SYSTEM' },
        correlationId: `scheduler:${definition.id}`,
      });
    }
  });

  it('[Concorrência] execução sem a trava conclui skipped e incrementa o contador', async () => {
    const metrics = new RecordingQueueMetrics();
    const held = { withAdvisoryLock: () => Promise.resolve({ acquired: false }) };
    const definition = SCHEDULERS.find((d) => d.id === 'maintenance-daily');
    if (!definition) throw new Error('definição ausente');
    let ran = false;
    const result = await runScheduled(definition, held, metrics, () => {
      ran = true;
      return Promise.resolve();
    });
    expect(result).toBe('skipped');
    expect(ran).toBe(false);
    expect(metrics.skipped).toEqual(['maintenance-daily']);
    expect(metrics.processed).toEqual([
      { queue: 'maintenance', jobName: 'daily', outcome: 'skipped' },
    ]);
  });

  it('alerta de SLA quando o último sucesso envelhece além do limite', async () => {
    const metrics = new RecordingQueueMetrics();
    const startedAt = new Date('2026-10-14T00:00:00.000Z');
    const lastSuccess = new Map([
      ['deadlines-tick', new Date('2026-10-15T12:30:00.000Z')],
      ['audit-seal-tick', new Date('2026-10-15T08:00:00.000Z')],
    ]);
    const missed = await checkSchedulerSla(
      { lastSuccess: (definition) => Promise.resolve(lastSuccess.get(definition.id) ?? null) },
      metrics,
      startedAt,
      NOW,
    );
    // audit-seal > 3 h; maintenance sem sucesso conhecido e processo no ar há > 26 h.
    expect(missed).toEqual(['audit-seal-tick', 'maintenance-daily']);
    expect(metrics.schedulerSuccess.get('deadlines-tick')).toEqual(
      lastSuccess.get('deadlines-tick'),
    );
  });
});

class MemoryQueues implements QueueAddPort {
  readonly added: {
    queue: QueueName;
    name: string;
    tenantId: string | null;
    jobId: string | undefined;
  }[] = [];

  add(
    queue: QueueName,
    name: string,
    data: JobData<unknown>,
    opts: { jobId?: string },
  ): Promise<void> {
    this.added.push({ queue, name, tenantId: data.meta.tenantId, jobId: opts.jobId });
    return Promise.resolve();
  }
}

function tickDatabase(): WorkerDatabase {
  const client: SqlClient = {
    query: (_sql: string, params: readonly unknown[] = []) => {
      const statuses = params[0] as string[];
      const rows = [
        { id: TENANT_A, status: 'ACTIVE' },
        { id: TENANT_B, status: 'SUSPENDED' },
      ].filter((row) => statuses.includes(row.status));
      return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
    },
  };
  return {
    tenantTransaction: (_tenant, work) => work(client),
    platformTransaction: (work) => work(client),
    withAdvisoryLock: async (_key, work) => ({ acquired: true, result: await work() }),
    close: () => Promise.resolve(),
  };
}

function platformJob(queue: string, name: string): RunnableJob {
  const definition = SCHEDULERS.find((d) => d.queue === queue && d.jobName === name);
  if (!definition) throw new Error('scheduler ausente');
  return {
    id: `repeat:${definition.id}:1`,
    name,
    queueName: queue,
    data: schedulerJobData(definition, NOW),
    attemptsMade: 0,
    opts: { attempts: 5 },
    timestamp: NOW.getTime(),
  };
}

describe('ticks agendados — um job por tenant e por iteração (queues.md §4.6–§4.8)', () => {
  function setup(handled: readonly string[]) {
    const queues = new MemoryQueues();
    const metrics = new RecordingQueueMetrics();
    const database = tickDatabase();
    const tickDeps = {
      producer: new JobProducer(queues, () => NOW),
      database,
      metrics,
      isHandled: (queue: QueueName, name: string) => handled.includes(`${queue}/${name}`),
      now: () => NOW,
    };
    const deps = {
      deadLetter: new MemoryDeadLetter(),
      metrics,
      timeoutMs: 1_000,
      postpone: () => Promise.resolve(),
      database,
    };
    return { queues, metrics, tickDeps, deps };
  }

  it('deadlines.tick enfileira scan-tenant só para tenants ACTIVE, com jobId por slot', async () => {
    const { queues, metrics, tickDeps, deps } = setup(['deadlines/scan-tenant']);
    await expect(
      runJob(platformJob('deadlines', 'tick'), new DeadlinesTick(tickDeps), deps),
    ).resolves.toBe('completed');
    const slot = Math.floor(NOW.getTime() / 900_000) * 900;
    expect(queues.added).toEqual([
      {
        queue: 'deadlines',
        name: 'scan-tenant',
        tenantId: TENANT_A,
        jobId: `deadlines.${TENANT_A}.${String(slot)}`,
      },
    ]);
    expect(metrics.schedulerSuccess.get('deadlines-tick')).toEqual(NOW);
  });

  it('sem handler do filho, o tick não enfileira nada (nada fica sem consumidor)', async () => {
    const { queues, tickDeps, deps } = setup([]);
    await runJob(platformJob('deadlines', 'tick'), new DeadlinesTick(tickDeps), deps);
    await runJob(platformJob('audit-seal', 'tick'), new AuditSealTick(tickDeps), deps);
    await runJob(platformJob('maintenance', 'daily'), new MaintenanceDaily(tickDeps), deps);
    expect(queues.added).toEqual([]);
  });

  it('audit-seal.tick: seal-tenant por tenant + seal-platform; maintenance.daily: plataforma + housekeeping', async () => {
    const { queues, tickDeps, deps } = setup([
      'audit-seal/seal-tenant',
      'audit-seal/seal-platform',
      'maintenance/outbox-purge',
      'maintenance/tenant-housekeeping',
    ]);
    await runJob(platformJob('audit-seal', 'tick'), new AuditSealTick(tickDeps), deps);
    await runJob(platformJob('maintenance', 'daily'), new MaintenanceDaily(tickDeps), deps);
    const period = Math.floor(NOW.getTime() / 3_600_000) * 3_600;
    expect(queues.added).toEqual([
      {
        queue: 'audit-seal',
        name: 'seal-tenant',
        tenantId: TENANT_A,
        jobId: `audit-seal.${TENANT_A}.${String(period)}`,
      },
      {
        queue: 'audit-seal',
        name: 'seal-platform',
        tenantId: null,
        jobId: `audit-seal.platform.${String(period)}`,
      },
      {
        queue: 'maintenance',
        name: 'outbox-purge',
        tenantId: null,
        jobId: 'maintenance.outbox-purge.2026-10-15',
      },
      {
        queue: 'maintenance',
        name: 'tenant-housekeeping',
        tenantId: TENANT_A,
        jobId: `maintenance.tenant-housekeeping.${TENANT_A}.2026-10-15`,
      },
      {
        queue: 'maintenance',
        name: 'tenant-housekeeping',
        tenantId: TENANT_B,
        jobId: `maintenance.tenant-housekeeping.${TENANT_B}.2026-10-15`,
      },
    ]);
  });
});

describe('registro de handlers (V-03)', () => {
  it('recusa nome fora de QUEUE_JOBS e registro duplicado', () => {
    const registry = new JobHandlerRegistry();
    const handler = {
      queue: 'email' as const,
      name: 'send',
      payloadSchema: z.unknown(),
      handle: () => Promise.resolve(undefined),
    };
    registry.register(handler);
    expect(() => registry.register(handler)).toThrow('duas vezes');
    expect(() => registry.register({ ...handler, name: 'enviar' })).toThrow(UnregisteredJobError);
    expect(registry.isHandled('email', 'send')).toBe(true);
    expect(registry.queues()).toEqual(['email']);
    expect(registry.all()).toHaveLength(1);
    expect(registry.get('email', 'x')).toBeUndefined();
  });

  it('todos os handlers de produção estão no registro de jobs', () => {
    const tickDeps = {
      producer: new JobProducer(new MemoryQueues()),
      database: tickDatabase(),
      metrics: new RecordingQueueMetrics(),
      isHandled: () => false,
    };
    const registry = new JobHandlerRegistry()
      .register(new DeadlinesTick(tickDeps))
      .register(new AuditSealTick(tickDeps))
      .register(new MaintenanceDaily(tickDeps))
      .register(
        new DomainEventsJobHandler(
          new DomainEventsProcessor({ queues: { add: () => Promise.resolve() }, handlers: [] }),
        ),
      )
      .register(
        new NotificationDispatcher({
          directory: new SqlNotificationDirectory(),
          email: { enqueue: () => Promise.resolve() },
        }),
      );
    for (const handler of registry.all()) {
      expect(QUEUE_JOBS[handler.queue] as readonly string[]).toContain(handler.name);
    }
    expect(registry.queues().sort()).toEqual([
      'audit-seal',
      'deadlines',
      'domain-events',
      'maintenance',
      'notifications',
    ]);
  });
});
