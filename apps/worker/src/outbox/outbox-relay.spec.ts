import { MAX_EVENT_PAYLOAD_BYTES } from '@contrataflow/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutboxRelay, cycleBackoffMs } from './outbox-relay.js';
import type { RelayLogger } from './outbox-relay.js';
import { MemoryOutboxDatabase, MemoryOutboxRepository, MemoryPublisher } from './testing.js';
import type { MemoryRow } from './testing.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';

/** Folga para os laços com timers reais quando a máquina está carregada (turbo em paralelo). */
const WAIT = { timeout: 5_000, interval: 5 };
const USER = '0192f000-0000-7000-8000-0000000000a1';

let sequence = 0;

/** UUIDv7 determinístico e crescente para as linhas de teste. */
function eventId(): string {
  sequence += 1;
  return `0192f3a0-5c1e-7a2b-9c3d-${sequence.toString(16).padStart(12, '0')}`;
}

function row(patch: Partial<MemoryRow> = {}): MemoryRow {
  const id = eventId();
  return {
    id,
    tenant_id: TENANT,
    event_type: 'ProbeCreated',
    routing_key: 'probe.created',
    event_version: 1,
    aggregate_type: 'Process',
    aggregate_id: USER,
    process_id: null,
    payload: { name: 'x' },
    metadata: {
      actor: { type: 'USER', userId: USER, membershipId: null },
      correlationId: 'corr-1',
      causationId: null,
    },
    occurred_at: new Date(Date.now() - 1_000 + sequence),
    attempts: 0,
    status: 'PENDING',
    next_attempt_at: null,
    published_at: null,
    last_error: null,
    ...patch,
  };
}

function logger(): RelayLogger & { entries: { level: string; event: unknown }[] } {
  const entries: { level: string; event: unknown }[] = [];
  const push = (level: string) => (message: unknown) => {
    entries.push({ level, event: (message as { event?: unknown }).event });
  };
  return { entries, log: push('log'), warn: push('warn'), error: push('error') };
}

function setup(options: { batchSize?: number } = {}) {
  const db = new MemoryOutboxDatabase();
  const publisher = new MemoryPublisher();
  const log = logger();
  const relay = new OutboxRelay(
    {
      database: db,
      publisher,
      repository: new MemoryOutboxRepository(db),
      logger: log,
      random: () => 0.5,
    },
    {
      batchSize: options.batchSize ?? 100,
      pollIntervalMs: 5,
      standbyRetryMs: 10,
      maxCycleBackoffMs: 20,
    },
  );
  return { db, publisher, log, relay };
}

const relays: OutboxRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

function started(relay: OutboxRelay): OutboxRelay {
  relays.push(relay);
  relay.start();
  return relay;
}

describe('OutboxRelay.runCycle (RN-FND-55/57)', () => {
  it('[Sucesso] publica com jobId = eventId e marca PUBLISHED com publishedAt', async () => {
    const { db, publisher, log, relay } = setup();
    db.rows.push(row(), row());

    const result = await relay.runCycle();

    expect(result).toEqual({ claimed: 2, published: 2, retried: 0, failed: 0 });
    expect([...publisher.jobs.keys()]).toEqual(db.rows.map((r) => r.id));
    const job = publisher.jobs.get(db.rows[0]?.id ?? '');
    expect(job?.data.payload.envelope).toMatchObject({
      eventId: db.rows[0]?.id,
      tenantId: TENANT,
      routingKey: 'probe.created',
    });
    expect(job?.data.meta).toMatchObject({ tenantId: TENANT, correlationId: 'corr-1' });
    expect(db.rows.every((r) => r.status === 'PUBLISHED' && r.published_at !== null)).toBe(true);
    expect(log.entries).toContainEqual({ level: 'log', event: 'outbox.relay_batch_published' });
  });

  it('lote vazio não publica nada', async () => {
    const { publisher, relay } = setup();
    expect(await relay.runCycle()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
    expect(publisher.calls).toEqual([]);
  });

  it('[V-04] linha acima de 16 KB ou fora do schema vai para backoff isolado; o lote segue', async () => {
    const { db, publisher, log, relay } = setup();
    const big = row({ payload: { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) } });
    const broken = row({ metadata: { correlationId: 'sem-ator' } });
    const bad = row({ routing_key: 'SemPonto' });
    const good = row();
    db.rows.push(big, broken, bad, good);

    const before = Date.now();
    const result = await relay.runCycle();

    expect(result).toEqual({ claimed: 4, published: 1, retried: 3, failed: 0 });
    expect([...publisher.jobs.keys()]).toEqual([good.id]);
    for (const invalid of [big, broken, bad]) {
      const stored = db.rows.find((r) => r.id === invalid.id);
      expect(stored).toMatchObject({ status: 'PENDING', attempts: 1 });
      // 1ª tentativa: base 5 s com jitter fixo em 0,5 → 3,75 s.
      expect(stored?.next_attempt_at?.getTime()).toBeGreaterThanOrEqual(before + 3_750);
      expect(stored?.last_error).not.toContain('xxxx');
    }
    expect(db.rows.find((r) => r.id === good.id)?.status).toBe('PUBLISHED');
    expect(log.entries.filter((e) => e.event === 'outbox.relay_retry')).toHaveLength(3);
    // Em backoff: o próximo ciclo não a reprocessa antes do horário.
    expect(await relay.runCycle()).toEqual({ claimed: 0, published: 0, retried: 0, failed: 0 });
  });

  it('na 10ª tentativa a linha vira FAILED com log de erro; o restante do lote não é bloqueado', async () => {
    const { db, publisher, log, relay } = setup();
    const poison = row({ payload: 'não é objeto', attempts: 9 });
    const good = row();
    db.rows.push(poison, good);

    expect(await relay.runCycle()).toEqual({ claimed: 2, published: 1, retried: 0, failed: 1 });
    expect(db.rows.find((r) => r.id === poison.id)).toMatchObject({
      status: 'FAILED',
      attempts: 10,
    });
    expect(publisher.jobs.has(good.id)).toBe(true);
    expect(log.entries).toContainEqual({
      level: 'error',
      event: 'outbox.relay_failed_permanently',
    });
  });

  it('[Falha de integração] Redis fora: o lote inteiro é desfeito e as linhas seguem PENDING', async () => {
    const { db, publisher, relay } = setup();
    db.rows.push(row(), row({ payload: 'inválida' }));
    publisher.down = true;

    await expect(relay.runCycle()).rejects.toThrow('Connection is closed.');
    expect(db.rows.map((r) => [r.status, r.attempts])).toEqual([
      ['PENDING', 0],
      ['PENDING', 0],
    ]);

    publisher.down = false;
    await relay.runCycle();
    expect(db.rows[0]?.status).toBe('PUBLISHED');
  });
});

describe('OutboxRelay — liderança e laço (RN-FND-54 · FA-01/FA-02)', () => {
  it('[Concorrência] só a líder processa; a réplica em espera não publica', async () => {
    const shared = setup();
    const standbyPublisher = new MemoryPublisher();
    const standby = new OutboxRelay(
      {
        database: shared.db,
        publisher: standbyPublisher,
        repository: new MemoryOutboxRepository(shared.db),
        logger: logger(),
      },
      { pollIntervalMs: 5, standbyRetryMs: 10, maxCycleBackoffMs: 20 },
    );
    started(shared.relay);
    await vi.waitFor(() => {
      expect(shared.relay.isLeader).toBe(true);
    }, WAIT);
    started(standby);
    shared.db.rows.push(row(), row(), row());

    await vi.waitFor(() => {
      expect(shared.db.rows.every((r) => r.status === 'PUBLISHED')).toBe(true);
    }, WAIT);
    expect(standby.isLeader).toBe(false);
    expect(standbyPublisher.calls).toEqual([]);
    expect(shared.publisher.jobs.size).toBe(3);
  });

  it('[FA-02] queda da líder: a réplica em espera assume a trava e continua', async () => {
    const first = setup();
    const second = new OutboxRelay(
      {
        database: first.db,
        publisher: first.publisher,
        repository: new MemoryOutboxRepository(first.db),
        logger: logger(),
      },
      { pollIntervalMs: 5, standbyRetryMs: 10, maxCycleBackoffMs: 20 },
    );
    started(first.relay);
    await vi.waitFor(() => {
      expect(first.relay.isLeader).toBe(true);
    }, WAIT);
    started(second);
    const leaderSession = first.db.lockHolder;
    // Derruba a conexão da líder sem parar o processo: a trava é liberada.
    leaderSession?.drop();
    first.db.down = true; // a réplica caída não reconecta
    await vi.waitFor(() => {
      expect(first.relay.isLeader).toBe(false);
    }, WAIT);
    first.db.down = false;
    await first.relay.stop();

    await vi.waitFor(() => {
      expect(second.isLeader).toBe(true);
    }, WAIT);
    first.db.rows.push(row());
    await vi.waitFor(() => {
      expect(first.db.rows[0]?.status).toBe('PUBLISHED');
    }, WAIT);
    expect(first.log.entries).toContainEqual({ level: 'warn', event: 'outbox.relay_leader_lost' });
  });

  it('[Falha de banco] PostgreSQL fora: tenta de novo com backoff e não perde eventos', async () => {
    const { db, publisher, log, relay } = setup();
    db.down = true;
    db.rows.push(row(), row());
    started(relay);

    await vi.waitFor(() => {
      expect(
        log.entries.filter((e) => e.event === 'outbox.relay_cycle_failed').length,
      ).toBeGreaterThan(1);
    }, WAIT);
    expect(db.rows.every((r) => r.status === 'PENDING')).toBe(true);

    db.down = false;
    await vi.waitFor(() => {
      expect(db.rows.every((r) => r.status === 'PUBLISHED')).toBe(true);
    }, WAIT);
    expect(publisher.jobs.size).toBe(2);
  });

  it('falha de banco durante a liderança: ciclo desfeito, backoff e retomada', async () => {
    const { db, log, relay } = setup();
    started(relay);
    await vi.waitFor(() => {
      expect(relay.isLeader).toBe(true);
    }, WAIT);
    db.down = true;
    db.rows.push(row());
    await vi.waitFor(() => {
      expect(log.entries.some((e) => e.event === 'outbox.relay_cycle_failed')).toBe(true);
    }, WAIT);
    db.down = false;
    await vi.waitFor(() => {
      expect(db.rows[0]?.status).toBe('PUBLISHED');
    }, WAIT);
  });

  it('lote cheio repete sem esperar; NOTIFY acorda o laço ocioso', async () => {
    const { db, publisher, relay } = setup({ batchSize: 2 });
    db.rows.push(row(), row(), row(), row(), row());
    started(relay);
    await vi.waitFor(() => {
      expect(publisher.jobs.size).toBe(5);
    }, WAIT);
    expect(publisher.calls.map((call) => call.length)).toEqual([2, 2, 1]);

    db.rows.push(row());
    db.lockHolder?.notify?.();
    await vi.waitFor(() => {
      expect(publisher.jobs.size).toBe(6);
    }, WAIT);
  });

  it('stop() encerra o laço e libera a trava; start() é idempotente', async () => {
    const { db, relay } = setup();
    started(relay);
    relay.start();
    await vi.waitFor(() => {
      expect(relay.isLeader).toBe(true);
    }, WAIT);
    await relay.stop();
    expect(relay.isLeader).toBe(false);
    expect(db.lockHolder).toBeNull();
  });
});

describe('cycleBackoffMs (FA-01)', () => {
  it('dobra a partir de 1 s até o teto de 30 s', () => {
    expect([1, 2, 3, 5, 6, 10].map((n) => cycleBackoffMs(n))).toEqual([
      1_000, 2_000, 4_000, 16_000, 30_000, 30_000,
    ]);
    expect(cycleBackoffMs(0)).toBe(1_000);
  });
});
