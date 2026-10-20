// Outbox transacional contra PostgreSQL real (US-082 · Gherkin "Eventos de domínio com outbox
// transacional"): migrações reais, a aplicação como `cf_app` (RLS) pela `TenantTransaction`, um
// agregado e uma projeção de timeline de teste (tabelas criadas só neste contêiner, com a mesma
// RLS das tabelas de negócio). Também na suíte "tenant leak" (`test:tenant-leak`).
// `pnpm --filter @contrataflow/api test:integration`.
import { defineDomainEvent } from '@contrataflow/validation';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OutboxContractError } from '#modules/platform/application/outbox-ports.js';
import { OutboxWriterService } from '#modules/platform/application/outbox-writer.service.js';
import { SyncEventHandlerRegistry } from '#modules/platform/application/sync-event-handler.registry.js';
import { PrismaOutboxStore } from '#modules/platform/infrastructure/outbox/prisma-outbox.store.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type { RecordedDomainEvent } from '#shared/outbox/outbox-writer.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ANA = FAKE_USERS.ana;
const ANA_IN_A = FAKE_MEMBERSHIPS.find((m) => m.userId === ANA.id && m.tenantId === A);

/** Agregado e projeção de teste com RLS ENABLE + FORCE, como as tabelas de negócio (DEC-082). */
const FIXTURE_SQL = `
  SET ROLE cf_owner;
  CREATE TABLE test_aggregates (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL);
  CREATE TABLE test_timeline_entries (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, source_event_id uuid NOT NULL,
    event_type text NOT NULL, note text,
    UNIQUE (tenant_id, source_event_id, event_type));
  ALTER TABLE test_aggregates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE test_aggregates FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON test_aggregates
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  ALTER TABLE test_timeline_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE test_timeline_entries FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON test_timeline_entries
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  GRANT SELECT, INSERT, UPDATE ON test_aggregates, test_timeline_entries TO cf_app;
  RESET ROLE;`;

const ProbeCreated = defineDomainEvent({
  eventType: 'ProbeCreated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({ name: z.string().min(1) }),
  routingKey: 'probe.created',
});

interface OutboxRowDb {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly routing_key: string;
  readonly status: string;
  readonly occurred_at: Date;
  readonly payload: unknown;
  readonly metadata: Record<string, unknown>;
}

/** Requisição autenticada da Ana no tenant (o que os guards fazem na API). */
function asAna<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'corr-us082', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: ANA.id, membershipId: ANA_IN_A?.id ?? null },
      });
      return fn();
    },
  );
}

describe('OutboxWriter no PostgreSQL (US-082)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;
  let writer: OutboxWriterService;
  const projected: { tenantSeen: string[]; updatedOthers: number }[] = [];
  let failProjection = false;

  /** Caso de uso de teste: grava o agregado e o fato no mesmo tx (RN-FND-49). */
  const createAggregate = (
    tenantId: string,
    name: string,
    after: (tx: TenantTx, event: RecordedDomainEvent) => Promise<void> = () => Promise.resolve(),
  ) =>
    asAna(tenantId, () =>
      app.$tenantTransaction(async (tx) => {
        const id = newId();
        await tx.$executeRaw`INSERT INTO test_aggregates (id, tenant_id, name)
                             VALUES (${id}::uuid, ${tenantId}::uuid, ${name})`;
        const event = await writer.record(
          tx,
          ProbeCreated.of({ aggregateId: id, processId: id, payload: { name } }),
        );
        await after(tx, event);
        return { id, event };
      }),
    );

  const rowsOf = (aggregateId: string) =>
    db.admin<OutboxRowDb>(
      `SELECT id, tenant_id, event_type, routing_key, status, occurred_at, payload, metadata
         FROM outbox_events WHERE aggregate_id = $1`,
      [aggregateId],
    );

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
    const registry = new SyncEventHandlerRegistry();
    // Projeção síncrona de teste no papel do TimelineProjector (o real chega com a US-059).
    registry.register({
      name: 'TimelineProjector',
      routingKeys: ['probe.*'],
      async handle(tx, event) {
        if (failProjection) throw new Error('projeção falhou');
        const seen = await tx.$queryRaw<{ tenant_id: string }[]>`
          SELECT DISTINCT tenant_id::text FROM test_timeline_entries`;
        // Tentativa de alterar tudo: a RLS limita ao tenant da transação.
        const updatedOthers = await tx.$executeRaw`
          UPDATE test_timeline_entries SET note = 'tocado' WHERE tenant_id <> ${event.tenantId}::uuid`;
        projected.push({ tenantSeen: seen.map((row) => row.tenant_id), updatedOthers });
        await tx.$executeRaw`
          INSERT INTO test_timeline_entries (id, tenant_id, source_event_id, event_type)
          VALUES (${newId()}::uuid, ${event.tenantId}::uuid, ${event.eventId}::uuid, ${event.eventType})`;
      },
    });
    writer = new OutboxWriterService(new PrismaOutboxStore(), registry);
  });

  afterAll(async () => {
    await db.stop();
  });

  it('[Sucesso] agregado, evento PENDING e projeção síncrona são gravados na mesma transação', async () => {
    const before = await db.admin<{ now: Date }>('SELECT clock_timestamp() AS now');
    const { id, event } = await createAggregate(A, 'Aquisição de notebooks');

    const [row] = await rowsOf(id);
    expect(row).toMatchObject({
      id: event.eventId,
      tenant_id: A,
      event_type: 'ProbeCreated',
      routing_key: 'probe.created',
      status: 'PENDING',
      payload: { name: 'Aquisição de notebooks' },
      metadata: {
        actor: { type: 'USER', userId: ANA.id, membershipId: ANA_IN_A?.id ?? null },
        correlationId: 'corr-us082',
        causationId: null,
      },
    });
    // occurred_at = clock_timestamp() do INSERT, devolvido no envelope.
    expect(row?.occurred_at.getTime()).toBeGreaterThanOrEqual(before[0]?.now.getTime() ?? 0);
    expect(event.occurredAt).toBe(row?.occurred_at.toISOString());

    const timeline = await db.admin<{ tenant_id: string }>(
      'SELECT tenant_id FROM test_timeline_entries WHERE source_event_id = $1',
      [event.eventId],
    );
    expect(timeline).toEqual([{ tenant_id: A }]);
  });

  it('[Validação] payload fora do schema é recusado antes do commit: nada é gravado', async () => {
    const name = `inválido-${newId()}`;
    const attempt = asAna(A, () =>
      app.$tenantTransaction(async (tx) => {
        const id = newId();
        await tx.$executeRaw`INSERT INTO test_aggregates (id, tenant_id, name)
                             VALUES (${id}::uuid, ${A}::uuid, ${name})`;
        await writer.record(
          tx,
          ProbeCreated.of({ aggregateId: id, payload: {} as unknown as { name: string } }),
        );
      }),
    );
    await expect(attempt).rejects.toThrow(OutboxContractError);
    expect(await db.admin('SELECT 1 FROM test_aggregates WHERE name = $1', [name])).toEqual([]);
  });

  it('handler síncrono que falha desfaz agregado, evento e projeção (RN-FND-52)', async () => {
    failProjection = true;
    const name = `falha-projecao-${newId()}`;
    try {
      await expect(createAggregate(A, name)).rejects.toThrow('projeção falhou');
    } finally {
      failProjection = false;
    }
    expect(await db.admin('SELECT 1 FROM test_aggregates WHERE name = $1', [name])).toEqual([]);
    expect(
      await db.admin(`SELECT 1 FROM outbox_events WHERE payload ->> 'name' = $1`, [name]),
    ).toEqual([]);
  });

  it('erro do caso de uso depois do record não deixa evento "fantasma"', async () => {
    const name = `fantasma-${newId()}`;
    await expect(
      createAggregate(A, name, () => Promise.reject(new Error('regra violada'))),
    ).rejects.toThrow('regra violada');
    expect(
      await db.admin(`SELECT 1 FROM outbox_events WHERE payload ->> 'name' = $1`, [name]),
    ).toEqual([]);
  });

  it('o NOTIFY cf_outbox só é entregue quando a transação confirma', async () => {
    const listener = new pg.Client({ connectionString: db.url('cf_relay') });
    await listener.connect();
    const received: string[] = [];
    listener.on('notification', (message) => received.push(message.channel));
    try {
      await listener.query('LISTEN cf_outbox');
      await expect(
        createAggregate(A, `rollback-${newId()}`, () => Promise.reject(new Error('desfaz'))),
      ).rejects.toThrow('desfaz');
      await listener.query('SELECT 1'); // dá a volta no servidor: notificações pendentes chegam
      expect(received).toEqual([]);

      await createAggregate(A, `commit-${newId()}`);
      await expect.poll(() => received, { timeout: 5_000 }).toEqual(['cf_outbox']);
    } finally {
      await listener.end();
    }
  });

  describe('[Tenant incorreto] handler síncrono não cruza tenant (suíte tenant leak)', () => {
    it('a projeção grava no tenant do caso de uso e não lê nem altera linhas de outro tenant', async () => {
      await createAggregate(B, 'Contratação da Prefeitura B');
      projected.length = 0;

      const { event } = await createAggregate(A, 'Contratação da Prefeitura A');

      expect(projected).toEqual([{ tenantSeen: [A], updatedOthers: 0 }]);
      const entries = await db.admin<{ tenant_id: string; note: string | null }>(
        'SELECT tenant_id, note FROM test_timeline_entries WHERE source_event_id = $1',
        [event.eventId],
      );
      expect(entries).toEqual([{ tenant_id: A, note: null }]);
      const untouched = await db.admin<{ note: string | null }>(
        'SELECT DISTINCT note FROM test_timeline_entries WHERE tenant_id = $1',
        [B],
      );
      expect(untouched).toEqual([{ note: null }]);
    });

    it('o outbox recusa gravar evento de outro tenant dentro da transação do tenant A', async () => {
      const attempt = asAna(A, () =>
        app.$tenantTransaction(
          (tx) => tx.$executeRaw`
            INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type,
                                       aggregate_id, payload, metadata)
            VALUES (${newId()}::uuid, ${B}::uuid, 'ProbeCreated', 'probe.created', 'Process',
                    ${newId()}::uuid, '{}'::jsonb, '{}'::jsonb)`,
        ),
      );
      await expect(attempt).rejects.toMatchObject({
        // US-100: a TenantTransaction trata a recusa da RLS como violação de isolamento (500).
        name: 'TenantIsolationViolationError',
        cause: { message: expect.stringMatching(/row-level security/) as unknown },
      });
    });
  });
});
