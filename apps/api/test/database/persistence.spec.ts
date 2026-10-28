// Padrão de persistência da US-081 contra PostgreSQL real: papéis e privilégios (RN-FND-46),
// concorrência otimista (RN-FND-42), escalas decimais (RN-FND-41), falha de banco, travas
// pessimistas (FA-04), imutabilidade de snapshot (DEC-084) e migrações (RN-FND-47).
// `pnpm --filter @contrataflow/api test:integration`.
import { Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DecimalScaleError, fromDbDecimal, toDbDecimal } from '#shared/database/decimal.js';
import { DatabaseUnavailableError, VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import { createTenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { withLockTiming } from '#shared/database/row-lock.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { asTenant, runPrisma, startTestDatabase } from './support/postgres.js';
import type { TestDatabase } from './support/postgres.js';

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;

/**
 * Agregado mutável de exemplo, criado como uma story de negócio criaria: dono `cf_owner`, colunas
 * padrão (DEC-083), RLS e GRANTs mínimos. `test_snapshots` recebe o trigger de DEC-084.
 */
const FIXTURE_SQL = `
SET ROLE cf_owner;
CREATE TABLE test_aggregates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  title text NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  next_number int NOT NULL DEFAULT 1,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
ALTER TABLE test_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_aggregates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_aggregates
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT, UPDATE ON test_aggregates TO cf_app;

CREATE TABLE test_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  content jsonb NOT NULL,
  content_hash varchar(64) NOT NULL,
  rendered_at timestamptz
);
ALTER TABLE test_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON test_snapshots
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
GRANT SELECT, INSERT, UPDATE ON test_snapshots TO cf_app;
CREATE TRIGGER test_snapshots_immutable BEFORE UPDATE ON test_snapshots
  FOR EACH ROW EXECUTE FUNCTION cf_prevent_snapshot_update('content', 'content_hash');
RESET ROLE;
`;

interface Aggregate {
  id: string;
  version: number;
  amount: string;
  next_number: number;
}

async function createAggregate(
  app: TenantPrismaClient,
  tenantId: string,
  values: { version?: number; amount?: string } = {},
): Promise<string> {
  const id = newId();
  await asTenant(tenantId, () =>
    app.$tenantTransaction(
      (tx) => tx.$executeRaw`
        INSERT INTO test_aggregates (id, tenant_id, title, amount, version)
        VALUES (${id}::uuid, ${tenantId}::uuid, 'Aquisição de notebooks',
                ${values.amount ?? '0'}::numeric, ${values.version ?? 1})`,
    ),
  );
  return id;
}

const findAggregate = async (tx: TenantTx, id: string) =>
  (
    await tx.$queryRaw<Aggregate[]>`
      SELECT id, version, amount::text AS amount, next_number FROM test_aggregates WHERE id = ${id}::uuid`
  )[0];

/** Repositório de exemplo: o UPDATE versionado que toda story de negócio repete. */
function renameAggregate(tx: TenantTx, id: string, expectedVersion: number, title: string) {
  return updateVersioned(
    { aggregateType: 'TestAggregate', aggregateId: id, expectedVersion },
    () =>
      tx.$executeRaw`
      UPDATE test_aggregates
         SET title = ${title}, version = version + 1, updated_at = now()
       WHERE id = ${id}::uuid AND version = ${expectedVersion}`,
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('padrão de persistência (PostgreSQL real)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    app = db.client('cf_app');
  });

  afterAll(async () => {
    await db.stop();
  });

  describe('[Permissão] papéis de banco (RN-FND-46)', () => {
    it('cria os papéis com os atributos mínimos; BYPASSRLS só no relay, na purga do outbox e no dono das funções', async () => {
      const roles = await db.admin<{
        rolname: string;
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        privileged: boolean;
      }>(`
        SELECT rolname, rolcanlogin, rolbypassrls, rolinherit,
               rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication AS privileged
        FROM pg_roles WHERE rolname LIKE 'cf\\_%' ORDER BY rolname`);
      expect(roles).toEqual([
        {
          rolname: 'cf_app',
          rolcanlogin: true,
          rolbypassrls: false,
          rolinherit: true,
          privileged: false,
        },
        {
          // Dono das funções SECURITY DEFINER de leitura entre tenants (US-087): sem login.
          rolname: 'cf_definer',
          rolcanlogin: false,
          rolbypassrls: true,
          rolinherit: true,
          privileged: false,
        },
        {
          // Purga do outbox (US-082 · DEC-072): só SELECT/DELETE em outbox_events.
          rolname: 'cf_maintenance',
          rolcanlogin: true,
          rolbypassrls: true,
          rolinherit: true,
          privileged: false,
        },
        {
          rolname: 'cf_migrator',
          rolcanlogin: true,
          rolbypassrls: false,
          rolinherit: false,
          privileged: false,
        },
        {
          rolname: 'cf_owner',
          rolcanlogin: false,
          rolbypassrls: false,
          rolinherit: true,
          privileged: false,
        },
        {
          // SystemDbService (US-100 · RN-TEN-26): sem BYPASSRLS — só as políticas de plataforma.
          rolname: 'cf_platform',
          rolcanlogin: true,
          rolbypassrls: false,
          rolinherit: true,
          privileged: false,
        },
        {
          rolname: 'cf_readonly_report',
          rolcanlogin: true,
          rolbypassrls: false,
          rolinherit: true,
          privileged: false,
        },
        {
          rolname: 'cf_relay',
          rolcanlogin: true,
          rolbypassrls: true,
          rolinherit: true,
          privileged: false,
        },
        {
          rolname: 'cf_worker',
          rolcanlogin: true,
          rolbypassrls: false,
          rolinherit: true,
          privileged: false,
        },
      ]);
    });

    it('os objetos pertencem a cf_owner, nunca a um papel de aplicação', async () => {
      const owners = await db.admin<{ name: string; owner: string }>(`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
        UNION ALL
        SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'cf\\_%' AND NOT p.prosecdef`);
      expect(owners.length).toBeGreaterThan(0);
      expect(new Set(owners.map((row) => row.owner))).toEqual(new Set(['cf_owner']));
      // Funções SECURITY DEFINER: leitura entre tenants sempre do cf_definer (US-087); a criação
      // de partições de audit_logs é da dona da tabela, a única que pode criá-las (US-073 · DEC-071).
      const definers = await db.admin<{ name: string; owner: string }>(`
        SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`);
      expect(definers).toEqual([
        { name: 'cf_audit_ensure_partitions', owner: 'cf_owner' },
        { name: 'cf_find_invitation', owner: 'cf_definer' },
        { name: 'cf_user_memberships', owner: 'cf_definer' },
      ]);
    });

    it('cf_app não altera a definição das tabelas nem cria objetos', async () => {
      const disable = asTenant(A, () =>
        app.$tenantTransaction(
          (tx) => tx.$executeRaw`ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY`,
        ),
      );
      await expect(disable).rejects.toThrow(/must be owner of table outbox_events/);
      const create = asTenant(A, () =>
        app.$tenantTransaction((tx) => tx.$executeRaw`CREATE TABLE intruder (id int)`),
      );
      await expect(create).rejects.toThrow(/permission denied for schema public/);
      for (const role of ['cf_worker', 'cf_relay', 'cf_maintenance', 'cf_readonly_report']) {
        const [can] = await db.admin<{ create: boolean }>(
          `SELECT has_schema_privilege($1, 'public', 'CREATE') AS create`,
          [role],
        );
        expect(can?.create).toBe(false);
      }
      const [rls] = await db.admin<{ on: boolean }>(
        `SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'outbox_events'`,
      );
      expect(rls?.on).toBe(true);
    });

    it('apenas cf_owner, via SET ROLE do migrador, altera a definição das tabelas', async () => {
      const migrator = new pg.Client({ connectionString: db.url('cf_migrator') });
      await migrator.connect();
      try {
        await migrator.query('BEGIN');
        // NOINHERIT: sem SET ROLE o migrador não age como dono.
        await expect(
          migrator.query('ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY'),
        ).rejects.toThrow(/must be owner/);
        await migrator.query('ROLLBACK');
        await migrator.query('BEGIN');
        await migrator.query('SET LOCAL ROLE cf_owner');
        await migrator.query('ALTER TABLE outbox_events DISABLE ROW LEVEL SECURITY');
        await migrator.query('ROLLBACK');
      } finally {
        await migrator.end();
      }
    });
  });

  describe('[Concorrência] versão otimista (DEC-055 · RN-FND-42)', () => {
    it('duas atualizações simultâneas com version 3: uma avança para 4, a outra conflita', async () => {
      const id = await createAggregate(app, A, { version: 3 });
      const log = vi.spyOn(Logger.prototype, 'log');
      const attempt = (title: string, holdMs: number) =>
        asTenant(A, () =>
          app.$tenantTransaction(async (tx) => {
            await renameAggregate(tx, id, 3, title);
            // Segura a trava da linha: a outra transação espera e reavalia o WHERE.
            await sleep(holdMs);
          }),
        );
      const results = await Promise.allSettled([attempt('Primeira', 300), attempt('Segunda', 0)]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(
        VersionConflictError,
      );
      const after = await asTenant(A, () => app.$tenantTransaction((tx) => findAggregate(tx, id)));
      expect(after?.version).toBe(4);
      expect(log.mock.calls.flat().join('\n')).toMatch(
        /db\.optimistic_concurrency_conflict aggregateType=TestAggregate aggregateId=\S+ expectedVersion=3/,
      );
      log.mockRestore();
    });

    it('a versão de outro tenant é invisível: atualizar um id de B a partir de A conflita', async () => {
      const id = await createAggregate(app, B);
      const attempt = asTenant(A, () =>
        app.$tenantTransaction((tx) => renameAggregate(tx, id, 1, 'Invasão')),
      );
      await expect(attempt).rejects.toBeInstanceOf(VersionConflictError);
      const [row] = await db.admin<{ title: string; version: number }>(
        'SELECT title, version FROM test_aggregates WHERE id = $1',
        [id],
      );
      expect(row).toEqual({ title: 'Aquisição de notebooks', version: 1 });
    });
  });

  describe('[Validação] escala decimal (DEC-003 · RN-FND-41)', () => {
    it('10.999 numa coluna Decimal(18,2) é rejeitado antes de qualquer gravação', async () => {
      const before = await db.admin<{ total: string }>(
        'SELECT count(*) AS total FROM test_aggregates',
      );
      const attempt = asTenant(A, () =>
        app.$tenantTransaction(async (tx) => {
          const amount = toDbDecimal('10.999', 'money');
          await tx.$executeRaw`
            INSERT INTO test_aggregates (id, tenant_id, title, amount)
            VALUES (${newId()}::uuid, ${A}::uuid, 'Escala inválida', ${amount}::numeric)`;
        }),
      );
      await expect(attempt).rejects.toBeInstanceOf(DecimalScaleError);
      const after = await db.admin<{ total: string }>(
        'SELECT count(*) AS total FROM test_aggregates',
      );
      expect(after).toEqual(before);
      // O banco arredondaria calado (numeric(18,2) → 11.00): por isso o mapeador rejeita.
      const [rounded] = await db.admin<{ value: string }>(
        "SELECT '10.999'::numeric(18,2)::text AS value",
      );
      expect(rounded?.value).toBe('11.00');
    });

    it('valor na escala grava e volta como decimal.js, sem passar por number', async () => {
      const id = await createAggregate(app, A, {
        amount: toDbDecimal(new Decimal('1234567.89'), 'money'),
      });
      const row = await asTenant(A, () => app.$tenantTransaction((tx) => findAggregate(tx, id)));
      const amount = fromDbDecimal(row?.amount ?? '');
      expect(amount).toBeInstanceOf(Decimal);
      expect(amount.equals('1234567.89')).toBe(true);
    });
  });

  describe('[Falha de banco] PostgreSQL indisponível', () => {
    it('abrir a TenantTransaction com o banco fora do ar falha como transitório (503)', async () => {
      const offline = createTenantPrismaClient({
        url: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
        poolSize: 1,
        maxWaitMs: 1_000,
        transactionTimeoutMs: 2_000,
        statementTimeoutMs: 1_000,
      });
      try {
        const attempt = asTenant(A, () =>
          offline.$tenantTransaction((tx) => tx.outboxEvent.count()),
        );
        const error = await attempt.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DatabaseUnavailableError);
        expect(error).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE' });
      } finally {
        await offline.$disconnect();
      }
    });

    it('a conexão cai no meio da transação: erro transitório e nenhuma alteração parcial', async () => {
      const id = newId();
      const attempt = asTenant(A, () =>
        app.$tenantTransaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO test_aggregates (id, tenant_id, title) VALUES (${id}::uuid, ${A}::uuid, 'Parcial')`;
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await db.admin('SELECT pg_terminate_backend($1)', [backend?.pid]);
          await tx.$executeRaw`UPDATE test_aggregates SET title = 'Depois' WHERE id = ${id}::uuid`;
        }),
      );
      await expect(attempt).rejects.toBeInstanceOf(DatabaseUnavailableError);
      expect(await db.admin('SELECT id FROM test_aggregates WHERE id = $1', [id])).toEqual([]);
    });
  });

  describe('transações (architecture.md §6.4–§6.5)', () => {
    it('FA-02: leitura roda em transação somente leitura', async () => {
      const attempt = asTenant(A, () =>
        app.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE test_aggregates SET title = 'x' WHERE tenant_id = ${A}::uuid`,
          { readOnly: true },
        ),
      );
      await expect(attempt).rejects.toThrow(/read-only transaction/);
    });

    it('FA-04: rollback depois de obter a trava libera a linha e não consome valor', async () => {
      const id = await createAggregate(app, A);
      const takeNumber = (tx: TenantTx) =>
        withLockTiming(
          { lockType: 'FOR UPDATE', tableName: 'test_aggregates' },
          () =>
            tx.$queryRaw<{ next_number: number }[]>`
            SELECT next_number FROM test_aggregates WHERE id = ${id}::uuid FOR UPDATE`,
        );
      const failing = asTenant(A, () =>
        app.$tenantTransaction(async (tx) => {
          await takeNumber(tx);
          await tx.$executeRaw`UPDATE test_aggregates SET next_number = next_number + 1 WHERE id = ${id}::uuid`;
          throw new Error('falha antes do commit');
        }),
      );
      await expect(failing).rejects.toThrow('falha antes do commit');
      const [taken] = await asTenant(A, () => app.$tenantTransaction(async (tx) => takeNumber(tx)));
      expect(taken?.next_number).toBe(1);
    });

    it('espera de trava acima de 200 ms gera warn db.lock_wait', async () => {
      const id = await createAggregate(app, A);
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const lock = (holdMs: number) =>
        asTenant(A, () =>
          app.$tenantTransaction(async (tx) => {
            await withLockTiming(
              { lockType: 'FOR UPDATE', tableName: 'test_aggregates' },
              () => tx.$queryRaw`SELECT id FROM test_aggregates WHERE id = ${id}::uuid FOR UPDATE`,
            );
            await sleep(holdMs);
          }),
        );
      const holder = lock(400);
      await sleep(100);
      await Promise.all([holder, lock(0)]);
      expect(warn.mock.calls.flat().join('\n')).toMatch(
        /db\.lock_wait lockType=FOR UPDATE tableName=test_aggregates durationMs=\d+/,
      );
      warn.mockRestore();
    });

    it('deadlock é refeito automaticamente (até 2 retentativas)', async () => {
      const first = await createAggregate(app, A);
      const second = await createAggregate(app, A);
      let attempts = 0;
      const crossLock = (one: string, other: string) =>
        asTenant(A, () =>
          app.$tenantTransaction(async (tx) => {
            attempts += 1;
            await tx.$queryRaw`SELECT id FROM test_aggregates WHERE id = ${one}::uuid FOR UPDATE`;
            await sleep(200);
            await tx.$queryRaw`SELECT id FROM test_aggregates WHERE id = ${other}::uuid FOR UPDATE`;
          }),
        );
      await Promise.all([crossLock(first, second), crossLock(second, first)]);
      expect(attempts).toBeGreaterThan(2);
    });
  });

  describe('snapshots imutáveis (DEC-084)', () => {
    it('UPDATE de coluna de conteúdo falha; demais colunas continuam atualizáveis', async () => {
      const id = newId();
      await asTenant(A, () =>
        app.$tenantTransaction(
          (tx) => tx.$executeRaw`
            INSERT INTO test_snapshots (id, tenant_id, content, content_hash)
            VALUES (${id}::uuid, ${A}::uuid, '{"sections":[]}', ${'a'.repeat(64)})`,
        ),
      );
      await asTenant(A, () =>
        app.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE test_snapshots SET rendered_at = now() WHERE id = ${id}::uuid`,
        ),
      );
      const tamper = asTenant(A, () =>
        app.$tenantTransaction(
          (tx) =>
            tx.$executeRaw`UPDATE test_snapshots SET content = '{"sections":[1]}' WHERE id = ${id}::uuid`,
        ),
      );
      await expect(tamper).rejects.toThrow(/snapshot imutável: test_snapshots\.content/);
    });
  });

  describe('migrações (RN-FND-47)', () => {
    it('reaplicar em outro banco do mesmo cluster reaproveita os papéis e não diverge do schema', async () => {
      await db.admin('CREATE DATABASE cf_second');
      const url = db.url('postgres').replace(/\/contrataflow$/, '/cf_second');
      // Extensões vêm do init da infraestrutura, não das migrações (RN-FND-14).
      const bootstrap = new pg.Client({ connectionString: url });
      await bootstrap.connect();
      try {
        await bootstrap.query('CREATE EXTENSION IF NOT EXISTS citext');
        // US-001: `processes` usa trigram e FTS sem acento (DEC-057).
        await bootstrap.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await bootstrap.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      } finally {
        await bootstrap.end();
      }
      await runPrisma(['migrate', 'deploy'], url);
      const second = new pg.Client({ connectionString: url });
      await second.connect();
      try {
        const { rows } = await second.query<{ owner: string }>(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'outbox_events'",
        );
        expect(rows).toEqual([{ owner: 'cf_owner' }]);
      } finally {
        await second.end();
      }
      // Banco só com as migrações (sem as tabelas de exemplo deste teste): o schema Prisma e as
      // migrações não divergem em tabelas, colunas e tipos — o que o cliente usa. O SQL bruto das
      // migrações (RN-FND-47) cria o que o Prisma não expressa: FKs compostas por tenant, índices
      // parciais/trigram/FTS e a coluna gerada `search_vector`, que o diff lista sem que sejam drift.
      const diff = await runPrisma(
        [
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--script',
        ],
        url,
      );
      const statements = diff.stdout
        .split(';')
        .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
        .filter((statement) => statement !== '');
      const RAW_SQL_ONLY = [
        /^ALTER TABLE "\w+" DROP CONSTRAINT "\w+_fkey"$/,
        /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+_fkey" FOREIGN KEY [\s\S]*$/,
        /^(CREATE( UNIQUE)?|DROP) INDEX "\w+"( ON [\s\S]*)?$/,
        /^ALTER TABLE "processes" ALTER COLUMN "search_vector" DROP DEFAULT$/,
      ];
      expect(
        statements.filter((statement) => !RAW_SQL_ONLY.some((pattern) => pattern.test(statement))),
      ).toEqual([]);
    });
  });
});
