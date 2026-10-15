// Suíte "tenant leak" no banco (US-081 · multi-tenancy.md §14 "RLS direto no banco" e "Catálogo"):
// PostgreSQL real com as migrações, tenants A e B com dados equivalentes em `outbox_events` e a
// aplicação conectada como `cf_app` pela `TenantTransaction`.
// `pnpm --filter @contrataflow/api test:tenant-leak` (também roda em `test:integration`).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { asTenant, startTestDatabase } from './support/postgres.js';
import type { TestDatabase } from './support/postgres.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

function outboxEvent(tenantId: string | null, eventType = 'ProcessCreated') {
  return {
    id: newId(),
    tenantId,
    eventType,
    routingKey: 'process.created',
    aggregateType: 'Process',
    aggregateId: newId(),
    payload: { number: 1 },
    metadata: { correlationId: 'test' },
  };
}

/** Insere como superusuário (sem RLS): a massa equivalente dos dois tenants. */
async function seed(db: TestDatabase, tenantId: string | null, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const event = outboxEvent(tenantId);
    await db.admin(
      `INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        tenantId,
        event.eventType,
        event.routingKey,
        event.aggregateType,
        event.aggregateId,
        event.payload,
        event.metadata,
      ],
    );
  }
}

const tenantsSeen = (tx: TenantTx) =>
  tx.$queryRaw<{ tenant_id: string | null; total: bigint }[]>`
    SELECT tenant_id, count(*) AS total FROM outbox_events GROUP BY tenant_id`;

describe('isolamento por tenant no banco (suíte tenant leak)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seed(db, A, 3);
    await seed(db, B, 3);
    await seed(db, null, 1); // evento de plataforma
    app = db.client('cf_app');
  });

  afterAll(async () => {
    await db.stop();
  });

  it('[Sucesso] gravação numa TenantTransaction define o contexto e persiste', async () => {
    const event = outboxEvent(A);
    const read = await asTenant(A, () =>
      app.$tenantTransaction(async (tx) => {
        const [context] = await tx.$queryRaw<{ tenant: string }[]>`
          SELECT current_setting('app.tenant_id') AS tenant`;
        await tx.outboxEvent.create({ data: event });
        return { context, row: await tx.outboxEvent.findUnique({ where: { id: event.id } }) };
      }),
    );
    expect(read.context?.tenant).toBe(A);
    expect(read.row).toMatchObject({ id: event.id, tenantId: A, status: 'PENDING', attempts: 0 });
    const [stored] = await db.admin<{ tenant_id: string }>(
      'SELECT tenant_id FROM outbox_events WHERE id = $1',
      [event.id],
    );
    expect(stored?.tenant_id).toBe(A);
  });

  it('[Tenant incorreto] o contexto de A nunca lê linhas de B nem de plataforma', async () => {
    const rows = await asTenant(A, () => app.$tenantTransaction(tenantsSeen, { readOnly: true }));
    expect(rows.map((row) => row.tenant_id)).toEqual([A]);
    const byId = await asTenant(A, async () => {
      const [fromB] = await db.admin<{ id: string }>(
        'SELECT id FROM outbox_events WHERE tenant_id = $1 LIMIT 1',
        [B],
      );
      return app.$tenantTransaction((tx) =>
        tx.outboxEvent.findUnique({ where: { id: fromB?.id ?? '' } }),
      );
    });
    expect(byId).toBeNull();
  });

  it('[Tenant incorreto] INSERT com tenant_id de B sob o contexto de A viola a política', async () => {
    const attempt = asTenant(A, () =>
      app.$tenantTransaction((tx) => tx.outboxEvent.create({ data: outboxEvent(B) })),
    );
    await expect(attempt).rejects.toThrow(/row-level security/i);
    const raw = asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$executeRaw`
          INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata)
          VALUES (${newId()}::uuid, ${B}::uuid, 'X', 'x', 'Process', ${newId()}::uuid, '{}', '{}')`,
      ),
    );
    await expect(raw).rejects.toThrow(/row-level security/i);
    const platform = asTenant(A, () =>
      app.$tenantTransaction((tx) => tx.outboxEvent.create({ data: outboxEvent(null) })),
    );
    await expect(platform).rejects.toThrow(/row-level security/i);
  });

  it('[Tenant incorreto] UPDATE sob o contexto de A não alcança linhas de B', async () => {
    // cf_app não tem UPDATE no outbox (só o relay): o papel do worker também não. Nenhuma linha de
    // B é tocada mesmo assim — o privilégio barra antes da política.
    const attempt = asTenant(A, () =>
      app.$tenantTransaction(
        (tx) =>
          tx.$executeRaw`UPDATE outbox_events SET attempts = attempts + 1 WHERE tenant_id = ${B}::uuid`,
      ),
    );
    await expect(attempt).rejects.toThrow(/permission denied/i);
    const [b] = await db.admin<{ attempts: number }>(
      'SELECT max(attempts) AS attempts FROM outbox_events WHERE tenant_id = $1',
      [B],
    );
    expect(b?.attempts).toBe(0);
  });

  it('[Duplicidade] a mesma conexão reaproveitada para A e depois B não vaza contexto', async () => {
    const single = db.client('cf_app', { poolSize: 1 });
    const pid = (tx: TenantTx) => tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const first = await asTenant(A, () =>
      single.$tenantTransaction(async (tx) => ({
        pid: await pid(tx),
        rows: await tenantsSeen(tx),
      })),
    );
    const second = await asTenant(B, () =>
      single.$tenantTransaction(async (tx) => ({
        pid: await pid(tx),
        rows: await tenantsSeen(tx),
      })),
    );
    expect(second.pid).toEqual(first.pid);
    expect(first.rows.map((row) => row.tenant_id)).toEqual([A]);
    expect(second.rows.map((row) => row.tenant_id)).toEqual([B]);

    // Fora da transação o contexto não sobrevive na conexão devolvida ao pool (escopo local).
    const leftover = await single.$queryRaw<{ value: string | null }[]>`
      SELECT current_setting('app.tenant_id', true) AS value`;
    expect(leftover[0]?.value ?? '').toBe('');
  });

  it('contexto ausente falha fechado: sem tenant no contexto, nada chega ao banco', async () => {
    await expect(
      asTenant(null, () => app.$tenantTransaction((tx) => tx.outboxEvent.findMany())),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(app.$tenantTransaction((tx) => tx.outboxEvent.findMany())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('contexto ausente falha fechado também no banco (consulta fora da TenantTransaction)', async () => {
    // Conexão nova: a variável nem existe → erro; nunca linhas de algum tenant.
    const fresh = db.client('cf_app', { poolSize: 1 });
    await expect(fresh.outboxEvent.findMany()).rejects.toThrow(/app\.tenant_id/);
    // Conexão já usada por uma TenantTransaction: a variável volta vazia → cast falha.
    await asTenant(A, () => fresh.$tenantTransaction((tx) => tx.outboxEvent.count()));
    await expect(fresh.outboxEvent.findMany()).rejects.toThrow(/uuid/i);
  });

  it('o worker (cf_worker) segue as mesmas regras de isolamento', async () => {
    const worker = db.client('cf_worker');
    const rows = await asTenant(B, () =>
      worker.$tenantTransaction(tenantsSeen, { readOnly: true }),
    );
    expect(rows.map((row) => row.tenant_id)).toEqual([B]);
  });

  it('o relay (cf_relay, BYPASSRLS) lê todos os tenants, mas só outbox_events', async () => {
    const relay = await db.admin<{ allowed: boolean }>(
      `SELECT has_table_privilege('cf_relay', 'outbox_events', 'SELECT')
          AND has_table_privilege('cf_relay', 'outbox_events', 'UPDATE')
          AND NOT has_table_privilege('cf_relay', 'outbox_events', 'INSERT')
          AND NOT has_table_privilege('cf_relay', 'outbox_events', 'DELETE') AS allowed`,
    );
    expect(relay[0]?.allowed).toBe(true);
  });

  it('[Permissão · US-082] o cf_relay é negado em qualquer tabela que não seja outbox_events', async () => {
    const relay = new pg.Client({ connectionString: db.url('cf_relay') });
    await relay.connect();
    try {
      for (const table of ['tenants', 'users', 'tenant_memberships', 'audit_logs']) {
        await expect(relay.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
          new RegExp(`permission denied for table ${table}`),
        );
      }
      // BYPASSRLS: enxerga os eventos de todos os tenants, sem app.tenant_id.
      const { rows } = await relay.query<{ tenants: string }>(
        'SELECT count(DISTINCT tenant_id)::text AS tenants FROM outbox_events',
      );
      expect(Number(rows[0]?.tenants)).toBeGreaterThanOrEqual(2);
    } finally {
      await relay.end();
    }
  });

  it('a purga (cf_maintenance, BYPASSRLS) só lê e apaga outbox_events (US-082 · DEC-072)', async () => {
    const [maintenance] = await db.admin<{ allowed: boolean; others: boolean }>(
      `SELECT has_table_privilege('cf_maintenance', 'outbox_events', 'SELECT')
          AND has_table_privilege('cf_maintenance', 'outbox_events', 'DELETE')
          AND NOT has_table_privilege('cf_maintenance', 'outbox_events', 'INSERT')
          AND NOT has_table_privilege('cf_maintenance', 'outbox_events', 'UPDATE') AS allowed,
              bool_or(has_table_privilege('cf_maintenance', c.oid, 'SELECT')) FILTER
                (WHERE c.relname <> 'outbox_events') AS others
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    expect(maintenance).toEqual({ allowed: true, others: false });
  });
});

describe('isolamento da trilha de auditoria (US-073 · suíte tenant leak)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  /** Registro mínimo como superusuário (sem RLS): a massa dos dois tenants e da plataforma. */
  const seedAudit = (tenantId: string | null, reasonCode: string | null = null) =>
    db.admin(
      `INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result,
                               reason_code, row_hash)
       VALUES ($1, now(), $2, 'USER', $3, $4, $5, $6, $7)`,
      [
        newId(),
        tenantId,
        reasonCode ? 'access.denied' : 'process.create',
        reasonCode ? 'ACCESS' : 'DATA_CHANGE',
        reasonCode ? 'DENIED' : 'SUCCESS',
        reasonCode,
        'f'.repeat(64),
      ],
    );

  beforeAll(async () => {
    db = await startTestDatabase();
    for (const tenantId of [A, A, B, B]) await seedAudit(tenantId);
    await seedAudit(null, 'MEMBERSHIP_INACTIVE'); // registro de plataforma
    app = db.client('cf_app');
  });

  afterAll(async () => {
    await db.stop();
  });

  const visible = (tenantId: string) =>
    asTenant(tenantId, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string | null }[]>`SELECT tenant_id FROM audit_logs`,
        { readOnly: true },
      ),
    );

  it('[Tenant incorreto] o contexto de A só vê a trilha de A — nem B, nem plataforma', async () => {
    expect((await visible(A)).map((row) => row.tenant_id)).toEqual([A, A]);
    expect((await visible(B)).map((row) => row.tenant_id)).toEqual([B, B]);
  });

  it('[Tenant incorreto] gravar na trilha de B (ou de plataforma) sob o contexto de A viola a RLS', async () => {
    const write = (tenantId: string | null) =>
      asTenant(A, () =>
        app.$tenantTransaction(
          (tx) => tx.$executeRaw`
            INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result,
                                    row_hash)
            VALUES (${newId()}::uuid, now(), ${tenantId}::uuid, 'USER', 'process.create',
                    'DATA_CHANGE', 'SUCCESS', ${'f'.repeat(64)})`,
        ),
      );
    await expect(write(B)).rejects.toThrow(/row-level security/);
    await expect(write(null)).rejects.toThrow(/row-level security/);
    await expect(write(A)).resolves.toBe(1);
  });

  it('sem app.tenant_id a leitura da trilha falha fechada (também direto numa partição)', async () => {
    const connection = new pg.Client({ connectionString: db.url('cf_app') });
    await connection.connect();
    try {
      await expect(connection.query('SELECT count(*) FROM audit_logs')).rejects.toThrow();
      // A aplicação não tem privilégio nas partições: só pela tabela-mãe, com RLS.
      const [partition] = await db.admin<{ name: string }>(
        `SELECT inhrelid::regclass::text AS name FROM pg_inherits
          WHERE inhparent = 'audit_logs'::regclass ORDER BY 1 LIMIT 1`,
      );
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await expect(
        connection.query(`SELECT count(*) FROM ${String(partition?.name)}`),
      ).rejects.toThrow(/permission denied/);
      await connection.query('ROLLBACK');
    } finally {
      await connection.end();
    }
  });
});

describe('catálogo do banco (multi-tenancy.md §14)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db.stop();
  });

  it('toda tabela com tenant_id tem RLS ENABLE + FORCE e a política tenant_isolation', async () => {
    const missing = await db.admin(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p')
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policies p
                            WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation'))`);
    expect(missing).toEqual([]);
    const tables = await db.admin<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity ORDER BY 1`);
    expect(tables.map((table) => table.relname)).toEqual(
      expect.arrayContaining(['outbox_events', 'audit_logs']),
    );
  });

  it('a política usa current_setting(app.tenant_id) em USING e WITH CHECK', async () => {
    const [policy] = await db.admin<{ qual: string; with_check: string }>(
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'outbox_events' AND policyname = 'tenant_isolation'`,
    );
    expect(policy?.qual).toContain("current_setting('app.tenant_id'::text)");
    expect(policy?.with_check).toContain("current_setting('app.tenant_id'::text)");
  });

  it('o plano da consulta filtrada pela política usa o índice iniciado por tenant_id', async () => {
    const connection = new pg.Client({ connectionString: db.url('cf_app') });
    await connection.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      // Tabela quase vazia: sem isto o planejador prefere a varredura sequencial.
      await connection.query('SET LOCAL enable_seqscan = off');
      const plan = await connection.query<{ 'QUERY PLAN': string }>(
        "EXPLAIN SELECT * FROM outbox_events WHERE aggregate_type = 'Process'",
      );
      await connection.query('ROLLBACK');
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'outbox_events_aggregate_idx',
      );
    } finally {
      await connection.end();
    }
  });
});
