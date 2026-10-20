// Integração do worker de filas (US-083): Gherkin de sucesso, validação, duplicidade,
// concorrência, falha de banco, falha de integração e permissão, com Redis e PostgreSQL reais.
import type { DeadLetterRecord } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  OperatorAuthenticator,
  PLATFORM_QUEUE_ADMIN,
  DatabaseOperatorDirectory,
} from '../../src/admin/operator-authenticator.js';
import { PlatformAuditWriter } from '../../src/admin/platform-audit.js';
import { startQueueDashboard } from '../../src/admin/queue-dashboard.js';
import type { QueueRuntimeConfig } from '../../src/config/queues.js';
import { BullQueues } from '../../src/queues/bull-queues.js';
import { buildDeadLetterRecord } from '../../src/queues/dead-letter.js';
import type { HandlerResult, JobHandler } from '../../src/queues/run-job.js';
import { SCHEDULERS } from '../../src/queues/schedulers.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import { startPostgres, startRedis } from '../support/containers.js';
import type { TestPostgres, TestRedis } from '../support/containers.js';
import {
  NOT_OPERATOR_SUBJECT,
  OPERATOR,
  OPERATOR_SUBJECT,
  TENANT_A,
  jobMeta,
  seedQueueFixtures,
  startRuntime,
} from '../support/queue-fixtures.js';
import type { RunningRuntime } from '../support/queue-fixtures.js';

let db: TestPostgres;
let redis: TestRedis;
const running: RunningRuntime[] = [];

beforeAll(async () => {
  Logger.overrideLogger(false);
  [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  await seedQueueFixtures(db);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((runtime) => runtime.stop()));
});

afterAll(async () => {
  await Promise.all([db.stop(), redis.stop()]);
});

function config(overrides: Partial<QueueRuntimeConfig> = {}): QueueRuntimeConfig {
  return {
    appEnv: 'test',
    redisUrl: redis.url,
    workerDatabaseUrl: db.url('cf_worker'),
    admin: null,
    ...overrides,
  };
}

async function start(...args: Parameters<typeof startRuntime>): Promise<RunningRuntime> {
  const runtime = await startRuntime(...args);
  running.push(runtime);
  return runtime;
}

const idPayload = z.strictObject({ id: z.string() });

function handlerOf(
  queue: JobHandler['queue'],
  name: string,
  handle: JobHandler<{ id: string }>['handle'],
): JobHandler<never> {
  return { queue, name, payloadSchema: idPayload, handle } as unknown as JobHandler<never>;
}

describe('worker de filas (US-083) — integração', () => {
  it('[Sucesso] job de notifications processa no contexto de banco da Prefeitura A', async () => {
    const seen: { tenant: string; types: number }[] = [];
    const worker = await start(config(), [
      handlerOf('notifications', 'event', async (_payload, context) => {
        const { rows } = await context.tenantTransaction((client) =>
          client.query<{ tenant: string; types: string }>(
            "SELECT current_setting('app.tenant_id') AS tenant, count(*)::text AS types FROM document_types",
          ),
        );
        seen.push({ tenant: rows[0]?.tenant ?? '', types: Number(rows[0]?.types) });
        return 'completed';
      }),
    ]);
    const id = await worker.add(
      'notifications',
      'event',
      { meta: jobMeta(TENANT_A), payload: { id: 'x' } },
      { jobId: 'ok-1' },
    );
    await vi.waitFor(
      async () => {
        expect(await worker.queue('notifications').getJobState(id)).toBe('completed');
      },
      { timeout: 15_000 },
    );
    expect(seen).toEqual([{ tenant: TENANT_A, types: 1 }]);
    expect(worker.metrics.processed).toContainEqual({
      queue: 'notifications',
      jobName: 'event',
      outcome: 'completed',
    });
  });

  it('[Validação] job sem tenantId falha definitivamente e é copiado para dead-letter.<fila>.<jobId>', async () => {
    const handle = vi.fn(() => Promise.resolve<HandlerResult>('completed'));
    const worker = await start(config(), [handlerOf('notifications', 'event', handle)]);
    const id = await worker.add(
      'notifications',
      'event',
      { meta: jobMeta(null), payload: { id: 'x' } },
      { jobId: 'no-tenant-1' },
    );
    await vi.waitFor(
      async () => {
        expect(await worker.queue('notifications').getJobState(id)).toBe('failed');
      },
      { timeout: 15_000 },
    );
    const failed = await worker.queue('notifications').getJob(id);
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toBe('TENANT_CONTEXT_REQUIRED');
    const copy = await worker.queue('dead-letter').getJob('notifications.no-tenant-1');
    expect((copy?.data as DeadLetterRecord).error).toMatchObject({
      class: 'SECURITY',
      code: 'TENANT_CONTEXT_REQUIRED',
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('[Duplicidade] reentrega do e-mail de N1 já SENT conclui sem reenviar', async () => {
    const status = new Map([['N1', 'PENDING']]);
    let sent = 0;
    const worker = await start(config(), [
      handlerOf('email', 'send', (payload) => {
        if (status.get(payload.id) !== 'PENDING') return Promise.resolve('skipped');
        sent += 1;
        status.set(payload.id, 'SENT');
        return Promise.resolve('completed');
      }),
    ]);
    const data = { meta: jobMeta(TENANT_A), payload: { id: 'N1' } };
    const first = await worker.add('email', 'send', data, { jobId: 'N1' });
    // Reentrega at-least-once (ex.: ack perdido): o mesmo trabalho chega de novo.
    const again = await worker.add('email', 'send', data, { jobId: 'N1-redelivery' });
    await vi.waitFor(
      async () => {
        expect(await worker.queue('email').getJobState(first)).toBe('completed');
        expect(await worker.queue('email').getJobState(again)).toBe('completed');
      },
      { timeout: 15_000 },
    );
    expect(sent).toBe(1);
    expect((await worker.queue('email').getJob(again))?.returnvalue).toBe('skipped');
  });

  it('[Concorrência] maintenance-daily em andamento: a outra réplica conclui skipped', async () => {
    const replicaA = await start(config(), []);
    const replicaB = await start(config(), []);
    // As duas réplicas sincronizaram os schedulers: um por id, sem duplicar.
    for (const definition of SCHEDULERS) {
      const schedulers = await replicaA.queue(definition.queue).getJobSchedulers();
      expect(schedulers.map((scheduler) => scheduler.key)).toEqual([definition.id]);
    }
    // Execução anterior em andamento: a trava consultiva do scheduler está segura.
    const holder = new pg.Client({ connectionString: db.url('cf_worker') });
    await holder.connect();
    try {
      await holder.query(
        "SELECT pg_advisory_lock(hashtextextended('cf:scheduler:maintenance-daily', 0))",
      );
      const data = {
        meta: jobMeta(null, { correlationId: 'scheduler:maintenance-daily' }),
        payload: {},
      };
      const id = await replicaB.add('maintenance', 'daily', data, { jobId: 'daily-skip' });
      await vi.waitFor(
        async () => {
          expect(await replicaB.queue('maintenance').getJobState(id)).toBe('completed');
        },
        { timeout: 15_000 },
      );
      expect((await replicaB.queue('maintenance').getJob(id))?.returnvalue).toBe('skipped');
      const skipped = [...replicaA.metrics.skipped, ...replicaB.metrics.skipped];
      expect(skipped).toEqual(['maintenance-daily']);
    } finally {
      await holder.end();
    }
  });

  it('[Falha de banco] PostgreSQL fora: transitório com backoff; breaker aberto não consome tentativa', async () => {
    const worker = await start(
      config({ workerDatabaseUrl: 'postgresql://cf_worker:x@127.0.0.1:1/contrataflow' }),
      [
        handlerOf('notifications', 'event', async (_payload, context) => {
          await context.tenantTransaction(() => Promise.resolve());
          return 'completed';
        }),
      ],
    );
    const id = await worker.add(
      'notifications',
      'event',
      { meta: jobMeta(TENANT_A), payload: { id: 'x' } },
      {
        jobId: 'db-down-1',
        attempts: 10,
        backoff: { type: 'cf-exponential-jitter', delay: 10 },
      },
    );
    // 5 falhas de conexão (retries com backoff) abrem o breaker do PostgreSQL; daí em diante o
    // job é adiado sem consumir tentativa.
    await vi.waitFor(
      () => {
        expect(worker.metrics.outcomes('notifications')).toContain('delayed');
      },
      { timeout: 20_000 },
    );
    const job = await worker.queue('notifications').getJob(id);
    expect(job?.attemptsMade).toBe(5);
    expect(await worker.queue('notifications').getJobState(id)).toBe('delayed');
    expect(worker.metrics.retries).toHaveLength(5);
    expect(worker.metrics.retries.every((retry) => retry.errorClass === 'TRANSIENT')).toBe(true);
    await worker
      .queue('notifications')
      .remove(id)
      .catch(() => undefined);
  });

  it(
    '[Falha de integração] Gotenberg fora pausa document-render sem consumir tentativa e retoma',
    { timeout: 90_000 },
    async () => {
      let rendered = 0;
      const worker = await start(config(), [], (runtime, registry) => {
        const gotenberg = runtime.breaker('gotenberg');
        gotenberg.trip();
        registry.register(
          handlerOf('document-render', 'render', async () => {
            await gotenberg.execute(() => Promise.resolve());
            rendered += 1;
            return 'completed';
          }),
        );
      });
      const id = await worker.add(
        'document-render',
        'render',
        { meta: jobMeta(TENANT_A), payload: { id: 'r1' } },
        { jobId: 'render-1' },
      );
      await vi.waitFor(
        async () => {
          expect(await worker.queue('document-render').getJobState(id)).toBe('delayed');
        },
        { timeout: 15_000 },
      );
      const paused = await worker.queue('document-render').getJob(id);
      expect(paused?.attemptsMade).toBe(0);
      expect(rendered).toBe(0);

      // A dependência volta: o breaker fecha e, ao fim do adiamento de 30 s, o job é retomado
      // sozinho — não se perdeu nem gastou tentativa.
      worker.runtime.breaker('gotenberg').reset();
      await vi.waitFor(
        async () => {
          expect(await worker.queue('document-render').getJobState(id)).toBe('completed');
        },
        { timeout: 45_000, interval: 500 },
      );
      const done = await worker.queue('document-render').getJob(id);
      expect(rendered).toBe(1);
      expect(done?.stacktrace).toEqual([]);
    },
  );

  it('dead-letter idempotente: a mesma falha gravada duas vezes (queda no meio) vira uma cópia', async () => {
    const bull = new BullQueues({ redisUrl: redis.url, appEnv: 'test' });
    try {
      const record = buildDeadLetterRecord(
        {
          queue: 'email',
          jobName: 'send',
          jobId: 'crash-1',
          attemptsMade: 5,
          enqueuedAt: 0,
          data: {},
          meta: null,
        },
        new Error('smtp'),
        'TRANSIENT_EXHAUSTED',
        new Date(),
      );
      await bull.park('email.crash-1', record);
      await bull.park('email.crash-1', {
        ...record,
        error: { ...record.error, message: 'segunda' },
      });
      const jobs = await bull.queue('dead-letter').getJobs(['waiting']);
      const copies = jobs.filter((job) => job.id === 'email.crash-1');
      expect(copies).toHaveLength(1);
      expect((copies[0]?.data as DeadLetterRecord).error.message).toBe('smtp');
      expect((await bull.deadLetterCounts()).get('email')).toBeGreaterThanOrEqual(1);
    } finally {
      await bull.close();
    }
  });

  it('[Permissão] Bull Board exige PLATFORM_QUEUE_ADMIN e MFA e abre somente leitura', async () => {
    const database = createWorkerDatabase({ url: db.url('cf_worker') });
    const bull = new BullQueues({ redisUrl: redis.url, appEnv: 'test' });
    const tokens: Record<string, { subject: string; amr: string[]; permissions: string[] }> = {
      'sem-permissao': {
        subject: NOT_OPERATOR_SUBJECT,
        amr: ['otp'],
        permissions: [PLATFORM_QUEUE_ADMIN],
      },
      'sem-mfa': { subject: OPERATOR_SUBJECT, amr: ['pwd'], permissions: [PLATFORM_QUEUE_ADMIN] },
      ok: { subject: OPERATOR_SUBJECT, amr: ['pwd', 'otp'], permissions: [PLATFORM_QUEUE_ADMIN] },
    };
    const dashboard = await startQueueDashboard(
      {
        queues: bull.all(),
        authenticator: new OperatorAuthenticator(
          {
            verify: (token) => {
              const claims = tokens[token];
              return claims ? Promise.resolve(claims) : Promise.reject(new Error('inválido'));
            },
          },
          new DatabaseOperatorDirectory(database),
        ),
        audit: new PlatformAuditWriter(database),
      },
      0,
      '127.0.0.1',
    );
    const base = `http://127.0.0.1:${String(dashboard.port)}`;
    const get = (path: string, token?: string, method = 'GET') =>
      fetch(`${base}${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    try {
      expect((await get('/health')).status).toBe(200);
      expect((await get('/queues')).status).toBe(401);
      const denied = await get('/queues', 'sem-permissao');
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        code: 'PERMISSION_DENIED',
        message: 'Você não tem permissão para acessar o painel de filas.',
      });
      const noMfa = await get('/queues', 'sem-mfa');
      expect(noMfa.status).toBe(403);
      expect(((await noMfa.json()) as { code: string }).code).toBe('MFA_REQUIRED');

      const page = await get('/queues', 'ok');
      expect(page.status).toBe(200);
      const api = await get('/queues/api/queues', 'ok');
      expect(api.status).toBe(200);
      const body = (await api.json()) as { queues: { name: string; readOnlyMode: boolean }[] };
      expect(body.queues.length).toBeGreaterThanOrEqual(9);
      expect(body.queues.every((queue) => queue.readOnlyMode)).toBe(true);
      // Mutação pelo painel: recusada antes mesmo do Bull Board (só a CLI auditada muta).
      expect((await get('/queues/api/queues/email/retry/failed', 'ok', 'PUT')).status).toBe(405);

      const audit = await db.admin<{
        result: string;
        reason_code: string | null;
        actor_user_id: string | null;
        actor_type: string;
      }>(
        "SELECT result::text, reason_code, actor_user_id, actor_type::text FROM audit_logs WHERE action = 'queue_dashboard.access' ORDER BY occurred_at",
      );
      expect(audit).toEqual([
        expect.objectContaining({
          result: 'DENIED',
          reason_code: 'PERMISSION_DENIED',
          actor_type: 'PLATFORM_OPERATOR',
        }),
        expect.objectContaining({
          result: 'DENIED',
          reason_code: 'MFA_REQUIRED',
          actor_user_id: OPERATOR,
        }),
        expect.objectContaining({ result: 'SUCCESS', reason_code: null, actor_user_id: OPERATOR }),
      ]);
      // A trilha de auditoria guarda o hash da linha calculado pelo worker.
      const [row] = await db.admin<{ row_hash: string }>(
        "SELECT row_hash FROM audit_logs WHERE action = 'queue_dashboard.access' LIMIT 1",
      );
      expect(row?.row_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await dashboard.close();
      await bull.close();
      await database.close();
    }
  });
});
