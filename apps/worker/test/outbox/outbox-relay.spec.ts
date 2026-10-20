// Relay do outbox e fan-out contra PostgreSQL e Redis reais (US-082 · Gherkin "Eventos de domínio
// com outbox transacional"): migrações reais, relay como `cf_relay`, purga como `cf_maintenance`,
// filas BullMQ de verdade. `pnpm --filter @contrataflow/worker test:integration`.
import { EventEmitter } from 'node:events';

import { uuidv7 } from '@contrataflow/observability';
import { DOMAIN_EVENTS_QUEUE } from '@contrataflow/types';
import { Queue, Worker } from 'bullmq';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startWorker } from '../../src/bootstrap.js';
import type { ShutdownProcess } from '../../src/graceful-shutdown.js';
import { BullDomainEventsPublisher } from '../../src/outbox/domain-events.publisher.js';
import { purgePublishedOutboxEvents } from '../../src/outbox/outbox-purge.js';
import type { PublishableEvent } from '../../src/outbox/outbox-record.js';
import { OutboxRelay } from '../../src/outbox/outbox-relay.js';
import type { OutboxRelayOptions, RelayLogger } from '../../src/outbox/outbox-relay.js';
import { OutboxRepository } from '../../src/outbox/outbox.repository.js';
import { queuePrefix } from '../../src/queues/queue-options.js';
import { TenantRedisCache } from '../../src/shared/cache/tenant-redis.js';
import { createOutboxDatabase } from '../../src/shared/database/outbox-database.js';
import type { OutboxDatabase, SqlClient } from '../../src/shared/database/outbox-database.js';
import { startPostgres, startRedis } from '../support/containers.js';
import type { TestPostgres, TestRedis } from '../support/containers.js';

const TENANT_A = '0192a000-0000-7000-8000-00000000000a';
const TENANT_B = '0192a000-0000-7000-8000-00000000000b';
const USER = '0192a000-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0192a000-0000-7000-8000-0000000001a1';

const silent: RelayLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

interface EventRow {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  readonly published_at: Date | null;
  readonly next_attempt_at: Date | null;
  readonly last_error: string | null;
}

class FakeProcess extends EventEmitter implements ShutdownProcess {
  exitCode: number | string | null | undefined = undefined;
  readonly exit = vi.fn<(code: number) => void>();
}

describe('relay do outbox no PostgreSQL + Redis (US-082)', () => {
  let db: TestPostgres;
  let redis: TestRedis;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    [db, redis] = await Promise.all([startPostgres(), startRedis()]);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await db.admin('DELETE FROM outbox_events');
  });

  afterAll(async () => {
    await Promise.all([db.stop(), redis.stop()]);
  });

  /** Eventos `PENDING` como o `OutboxWriter` os grava (envelope válido, `clock_timestamp()`). */
  async function insertEvents(
    count: number,
    patch: { routingKey?: string; tenantId?: string; payload?: unknown } = {},
  ): Promise<string[]> {
    const ids = Array.from({ length: count }, () => uuidv7());
    await db.admin(
      `INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type,
                                  aggregate_id, process_id, payload, metadata, occurred_at)
       SELECT id, $2, 'ProbeCreated', $3, 'Process', $4, $4, $5, $6, clock_timestamp()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, n) ORDER BY n`,
      [
        ids,
        patch.tenantId ?? TENANT_A,
        patch.routingKey ?? 'probe.created',
        USER,
        JSON.stringify(patch.payload ?? { name: 'x' }),
        JSON.stringify({
          actor: { type: 'USER', userId: USER, membershipId: MEMBERSHIP },
          correlationId: 'corr-it',
          causationId: null,
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        }),
      ],
    );
    return ids;
  }

  const rows = (ids: readonly string[]) =>
    db.admin<EventRow>(
      `SELECT id, status, attempts, published_at, next_attempt_at, last_error
         FROM outbox_events WHERE id = ANY($1::uuid[]) ORDER BY occurred_at, id`,
      [ids],
    );

  function queue(appEnv: string, name: string = DOMAIN_EVENTS_QUEUE): Queue {
    const instance = new Queue(name, {
      connection: { url: redis.url },
      prefix: queuePrefix(appEnv),
    });
    cleanups.push(() => instance.close());
    return instance;
  }

  function database(role: 'cf_relay' | 'cf_maintenance' = 'cf_relay'): OutboxDatabase {
    const instance = createOutboxDatabase({ url: db.url(role) });
    cleanups.push(() => instance.close());
    return instance;
  }

  interface RelayHandle {
    readonly relay: OutboxRelay;
    readonly published: string[];
  }

  function relay(
    appEnv: string,
    options: OutboxRelayOptions = {},
    deps: { repository?: OutboxRepository; redisUrl?: string } = {},
  ): RelayHandle {
    const publisher = new BullDomainEventsPublisher({
      redisUrl: deps.redisUrl ?? redis.url,
      appEnv,
      timeoutMs: 1_000,
    });
    const published: string[] = [];
    const instance = new OutboxRelay(
      {
        database: database(),
        publisher: {
          publish: async (events: readonly PublishableEvent[]) => {
            await publisher.publish(events);
            published.push(...events.map((event) => event.jobId));
          },
          close: () => publisher.close(),
        },
        logger: silent,
        ...(deps.repository ? { repository: deps.repository } : {}),
      },
      { pollIntervalMs: 50, standbyRetryMs: 200, maxCycleBackoffMs: 500, ...options },
    );
    cleanups.push(async () => {
      await instance.stop();
      await publisher.close();
    });
    return { relay: instance, published };
  }

  async function jobCount(target: Queue): Promise<number> {
    const counts = await target.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return Object.values(counts).reduce((sum, value) => sum + value, 0);
  }

  it('[Sucesso] evento PENDING é publicado em domain-events (jobId = eventId), marcado PUBLISHED e distribuído', async () => {
    const appEnv = 'test';
    const cache = new TenantRedisCache({ redisUrl: redis.url, appEnv });
    await cache.connect();
    cleanups.push(() => {
      cache.close();
      return Promise.resolve();
    });
    const permissionKey = cache.key(TENANT_A, ['access', 'eff', MEMBERSHIP]);
    await cache.redis.set(permissionKey, '[]', 'EX', 300);

    const proc = new FakeProcess();
    const { stopped } = await startWorker({
      proc,
      logger: false,
      outbox: { appEnv, relayDatabaseUrl: db.url('cf_relay'), redisUrl: redis.url },
    });
    try {
      const [id] = await insertEvents(1, {
        routingKey: 'role.assigned',
        payload: { membershipId: MEMBERSHIP },
      });
      const domainEvents = queue(appEnv);
      const notifications = queue(appEnv, 'notifications');

      await vi.waitFor(
        async () => {
          expect((await rows([id ?? '']))[0]).toMatchObject({ status: 'PUBLISHED', attempts: 1 });
          expect(await notifications.getJob(id ?? '')).toBeDefined();
          expect(await cache.redis.exists(permissionKey)).toBe(0);
        },
        { timeout: 15_000, interval: 100 },
      );
      const job = await domainEvents.getJob(id ?? '');
      expect(job?.id).toBe(id);
      expect(job?.data).toMatchObject({
        meta: { tenantId: TENANT_A, correlationId: 'corr-it' },
        payload: { envelope: { eventId: id, routingKey: 'role.assigned' } },
      });
      const child = await notifications.getJob(id ?? '');
      expect(child?.data).toMatchObject({ meta: { causationId: id } });
      expect((await rows([id ?? '']))[0]?.published_at).toBeInstanceOf(Date);
    } finally {
      proc.emit('SIGTERM');
      await stopped;
    }
  });

  it('[Permissão] o cf_relay não lê outras tabelas nem apaga eventos', async () => {
    const client = new pg.Client({ connectionString: db.url('cf_relay') });
    await client.connect();
    try {
      await expect(client.query('SELECT 1 FROM tenants')).rejects.toThrow(/permission denied/);
      await expect(client.query('SELECT 1 FROM audit_logs')).rejects.toThrow(/permission denied/);
      await expect(client.query('DELETE FROM outbox_events')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it('[Concorrência] SKIP LOCKED: duas transações nunca travam a mesma linha', async () => {
    await insertEvents(10);
    const repository = new OutboxRepository();
    const first = database();
    const second = database();
    let releaseFirst: () => void = () => undefined;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstIds: string[] = [];
    const firstTx = first.transaction(async (client: SqlClient) => {
      firstIds = (await repository.claimPendingBatch(client, 6)).map((r) => r.id);
      await firstHolds;
    });
    await vi.waitFor(() => {
      expect(firstIds).toHaveLength(6);
    });
    const secondIds = await second.transaction(async (client: SqlClient) =>
      (await repository.claimPendingBatch(client, 100)).map((r) => r.id),
    );
    releaseFirst();
    await firstTx;
    expect(secondIds).toHaveLength(4);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('[Concorrência] duas réplicas disputam a liderança: só uma publica e nenhuma linha sai duplicada', async () => {
    const appEnv = 'it-replicas';
    const a = relay(appEnv);
    const b = relay(appEnv);
    a.relay.start();
    b.relay.start();
    const ids = await insertEvents(300);

    await vi.waitFor(
      async () => {
        expect((await rows(ids)).every((r) => r.status === 'PUBLISHED')).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );
    expect([a.relay.isLeader, b.relay.isLeader].filter(Boolean)).toHaveLength(1);
    const all = [...a.published, ...b.published];
    expect(all).toHaveLength(300);
    expect(new Set(all).size).toBe(300);
    expect(a.published.length === 0 || b.published.length === 0).toBe(true);
    expect(await jobCount(queue(appEnv))).toBe(300);
  });

  it('[FA-02] queda da líder: a réplica em espera assume a trava em até 5 s', async () => {
    const appEnv = 'it-failover';
    const a = relay(appEnv, { standbyRetryMs: 5_000 });
    a.relay.start();
    await vi.waitFor(() => {
      expect(a.relay.isLeader).toBe(true);
    });
    const b = relay(appEnv, { standbyRetryMs: 5_000 });
    b.relay.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(b.relay.isLeader).toBe(false);

    await a.relay.stop();
    const lostAt = Date.now();
    await vi.waitFor(
      () => {
        expect(b.relay.isLeader).toBe(true);
      },
      { timeout: 6_000, interval: 50 },
    );
    expect(Date.now() - lostAt).toBeLessThanOrEqual(5_500);
    const ids = await insertEvents(3);
    await vi.waitFor(async () => {
      expect((await rows(ids)).every((r) => r.status === 'PUBLISHED')).toBe(true);
    });
  });

  it('[Duplicidade] UPDATE para PUBLISHED falhou após o enfileiramento: a reentrega é absorvida pelo jobId', async () => {
    const appEnv = 'it-duplicate';
    let failures = 1;
    const repository = new (class extends OutboxRepository {
      override async markPublished(client: SqlClient, ids: readonly string[]): Promise<number> {
        if (failures > 0) {
          failures -= 1;
          throw new Error('conexão perdida antes do COMMIT');
        }
        return super.markPublished(client, ids);
      }
    })();
    const handle = relay(appEnv, {}, { repository });
    const ids = await insertEvents(5);

    await expect(handle.relay.runCycle()).rejects.toThrow('conexão perdida');
    expect((await rows(ids)).map((r) => r.status)).toEqual(Array(5).fill('PENDING'));
    expect(await jobCount(queue(appEnv))).toBe(5);

    expect(await handle.relay.runCycle()).toMatchObject({ claimed: 5, published: 5 });
    expect((await rows(ids)).map((r) => [r.status, r.attempts])).toEqual(
      Array(5).fill(['PUBLISHED', 1]),
    );
    expect(handle.published).toHaveLength(10); // enviado duas vezes…
    expect(await jobCount(queue(appEnv))).toBe(5); // …mas a fila guarda um job por evento

    const processed: string[] = [];
    const consumer = new Worker(
      DOMAIN_EVENTS_QUEUE,
      (job) => {
        processed.push(job.id ?? '');
        return Promise.resolve();
      },
      { connection: { url: redis.url, maxRetriesPerRequest: null }, prefix: queuePrefix(appEnv) },
    );
    cleanups.push(() => consumer.close());
    await vi.waitFor(() => {
      expect(processed).toHaveLength(5);
    });
    expect(new Set(processed)).toEqual(new Set(ids));
  });

  it('[Falha de integração] Redis fora: rollback, linhas PENDING com travas liberadas e publicação única quando volta', async () => {
    const appEnv = 'it-redis-down';
    const ids = await insertEvents(4);
    const down = relay(appEnv, {}, { redisUrl: 'redis://127.0.0.1:1' });

    await expect(down.relay.runCycle()).rejects.toThrow();
    expect((await rows(ids)).map((r) => [r.status, r.attempts])).toEqual(
      Array(4).fill(['PENDING', 0]),
    );
    // Travas liberadas: outra transação consegue travar as linhas na hora.
    const locked = await db.admin(
      `SELECT id FROM outbox_events WHERE id = ANY($1::uuid[]) FOR UPDATE NOWAIT`,
      [ids],
    );
    expect(locked).toHaveLength(4);

    const up = relay(appEnv);
    expect(await up.relay.runCycle()).toMatchObject({ published: 4 });
    expect(await jobCount(queue(appEnv))).toBe(4);
    expect((await rows(ids)).every((r) => r.status === 'PUBLISHED')).toBe(true);
  });

  it('[Falha de banco] conexões do relay derrubadas: retoma com backoff e nada se perde', async () => {
    const appEnv = 'it-db-down';
    const handle = relay(appEnv);
    handle.relay.start();
    await vi.waitFor(() => {
      expect(handle.relay.isLeader).toBe(true);
    });
    const ids = await insertEvents(2);
    await db.admin(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE usename = 'cf_relay' AND pid <> pg_backend_pid()`,
    );
    const later = await insertEvents(3);

    await vi.waitFor(
      async () => {
        expect((await rows([...ids, ...later])).every((r) => r.status === 'PUBLISHED')).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(handle.relay.isLeader).toBe(true);
    expect(await jobCount(queue(appEnv))).toBe(5);
  });

  it('[V-04] linha acima de 16 KB não bloqueia o lote: backoff isolado e, na 10ª tentativa, FAILED', async () => {
    const appEnv = 'it-poison';
    const [big] = await insertEvents(1, { payload: { blob: 'x'.repeat(17 * 1024) } });
    const [poison] = await insertEvents(1, { payload: { blob: 'y'.repeat(17 * 1024) } });
    const good = await insertEvents(2);
    await db.admin('UPDATE outbox_events SET attempts = 9 WHERE id = $1', [poison]);

    const handle = relay(appEnv);
    expect(await handle.relay.runCycle()).toEqual({
      claimed: 4,
      published: 2,
      retried: 1,
      failed: 1,
    });
    const [bigRow, poisonRow] = await rows([big ?? '', poison ?? '']);
    expect(bigRow).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(bigRow?.next_attempt_at?.getTime()).toBeGreaterThan(Date.now());
    expect(bigRow?.last_error).toMatch(/payload acima/);
    expect(poisonRow).toMatchObject({ status: 'FAILED', attempts: 10 });
    expect((await rows(good)).every((r) => r.status === 'PUBLISHED')).toBe(true);
  });

  it('[Purga] cf_maintenance remove só PUBLISHED com mais de 7 dias, em lotes', async () => {
    const old = await insertEvents(5);
    const recent = await insertEvents(2);
    const [pending] = await insertEvents(1);
    const [failed] = await insertEvents(1, { tenantId: TENANT_B });
    await db.admin(
      `UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() - interval '8 days'
        WHERE id = ANY($1::uuid[])`,
      [old],
    );
    await db.admin(
      `UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() - interval '6 days'
        WHERE id = ANY($1::uuid[])`,
      [recent],
    );
    await db.admin(
      `UPDATE outbox_events SET occurred_at = now() - interval '30 days' WHERE id = $1`,
      [pending],
    );
    await db.admin(
      `UPDATE outbox_events SET status = 'FAILED', occurred_at = now() - interval '30 days'
        WHERE id = $1`,
      [failed],
    );

    const deleted = await purgePublishedOutboxEvents(database('cf_maintenance'), { batchSize: 2 });

    expect(deleted).toBe(5);
    const left = await db.admin<{ id: string }>('SELECT id FROM outbox_events');
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([...recent, pending, failed]));
    // Idempotente.
    expect(await purgePublishedOutboxEvents(database('cf_maintenance'))).toBe(0);
  });

  it('[SLO] 1.000 eventos: lag p95 (commit → PUBLISHED) abaixo de 5 s', async () => {
    const appEnv = 'it-lag';
    const handle = relay(appEnv);
    handle.relay.start();
    await vi.waitFor(() => {
      expect(handle.relay.isLeader).toBe(true);
    });
    const ids = await insertEvents(1_000);

    await vi.waitFor(
      async () => {
        const [pending] = await db.admin<{ n: string }>(
          `SELECT count(*)::text AS n FROM outbox_events WHERE status = 'PENDING'`,
        );
        expect(pending?.n).toBe('0');
      },
      { timeout: 30_000, interval: 100 },
    );
    const [lag] = await db.admin<{ p95: number }>(
      `SELECT percentile_cont(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM published_at - occurred_at)) AS p95
         FROM outbox_events WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(lag?.p95).toBeLessThan(5);
    expect(await jobCount(queue(appEnv))).toBe(1_000);
  });
});
