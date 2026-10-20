// US-100 · Contexto de tenant e isolamento no PostgreSQL real (Testcontainers + migrações): RLS em
// toda tabela com tenant_id (enumeradas do catálogo), papéis (cf_app, cf_relay, cf_platform), FKs
// compostas, funções SECURITY DEFINER, `cf_apply_tenant_rls` e o SystemDbService.
// `pnpm --filter @contrataflow/api test:tenant-leak` (também roda em `test:integration`).
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { TenantIsolationViolationError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import { NO_TENANT, SystemDbService } from '#shared/database/system-db.service.js';
import { TENANT_SCOPED_MODELS } from '#shared/database/tenant-models.js';

import { asTenant, startTestDatabase } from './support/postgres.js';
import type { TestDatabase } from './support/postgres.js';

const A = '0192b000-0000-7000-8000-00000000000a';
const B = '0192b000-0000-7000-8000-00000000000b';
const BRUNO = '0192b000-0000-7000-8000-0000000000b1';
const CARLA = '0192b000-0000-7000-8000-0000000000c1';
const BRUNO_A = '0192b000-0000-7000-8000-0000000001b1';
const CARLA_A = '0192b000-0000-7000-8000-0000000001c1';
const CARLA_B = '0192b000-0000-7000-8000-0000000002c1';
const DEPT_A = '0192b000-0000-7000-8000-0000000003a1';
const DEPT_B = '0192b000-0000-7000-8000-0000000003b1';
const ORG_A = '0192b000-0000-7000-8000-0000000004a1';
const ORG_B = '0192b000-0000-7000-8000-0000000004b1';
const INVITE_HASH = 'a'.repeat(64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, plan) VALUES
  ('${A}', 'prefeitura-a', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC', 'ENTERPRISE'),
  ('${B}', 'prefeitura-b', 'Prefeitura B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'STANDARD');
INSERT INTO users (id, email, name) VALUES
  ('${BRUNO}', 'bruno@prefeitura-a.test', 'Bruno'),
  ('${CARLA}', 'carla@consultoria.test', 'Carla');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, job_title, invite_token_hash, invite_expires_at, expires_at) VALUES
  ('${BRUNO_A}', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE', 'LEAK-A', NULL, NULL, NULL),
  ('${CARLA_A}', '${A}', '${CARLA}', 'EXTERNAL', 'ACTIVE', 'LEAK-A', NULL, NULL, now() + interval '30 days'),
  ('${CARLA_B}', '${B}', '${CARLA}', 'EXTERNAL', 'INVITED', 'LEAK-B', '${INVITE_HASH}', now() + interval '2 days', now() + interval '30 days');
-- Unidades (US-102): a lotação tem FK composta para \`departments\`.
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type) VALUES
  ('${ORG_A}', '${A}', 'Órgão A', 'OA', '11222333000181', 'DIRECT_ADMINISTRATION'),
  ('${ORG_B}', '${B}', 'Órgão B', 'OB', '11444777000161', 'DIRECT_ADMINISTRATION');
INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth) VALUES
  ('${DEPT_A}', '${A}', '${ORG_A}', 'SECTOR', 'Setor A', '/${DEPT_A}/', 0),
  ('${DEPT_B}', '${B}', '${ORG_B}', 'SECTOR', 'Setor B', '/${DEPT_B}/', 0);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('${newId()}', '${A}', '${BRUNO_A}', '${DEPT_A}', true),
  ('${newId()}', '${B}', '${CARLA_B}', '${DEPT_B}', true);
INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata) VALUES
  ('${newId()}', '${A}', 'ProcessCreated', 'process.created', 'Process', '${newId()}', '{}', '{}'),
  ('${newId()}', '${B}', 'ProcessCreated', 'process.created', 'Process', '${newId()}', '{}', '{}');
INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result, row_hash) VALUES
  ('${newId()}', now(), '${A}', 'USER', 'process.create', 'DATA_CHANGE', 'SUCCESS', '${'f'.repeat(64)}'),
  ('${newId()}', now(), '${B}', 'USER', 'process.create', 'DATA_CHANGE', 'SUCCESS', '${'f'.repeat(64)}');
`;

/** Tabelas com coluna tenant_id no schema public (tabelas-mãe; partições pela raiz). */
async function tenantTables(db: TestDatabase): Promise<string[]> {
  const rows = await db.admin<{ table_name: string }>(`
    SELECT c.table_name FROM information_schema.columns c
    JOIN pg_class k ON k.relname = c.table_name AND NOT k.relispartition
      AND k.relkind IN ('r', 'p')
    JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`);
  return rows.map((row) => row.table_name);
}

/** Executa `fn` numa conexão crua do papel, dentro de uma transação com `app.tenant_id`. */
async function rawAs<T>(
  db: TestDatabase,
  role: 'cf_app' | 'cf_worker' | 'cf_platform',
  tenantId: string | null,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: db.url(role) });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe('fundação do isolamento por tenant no banco (US-100)', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('[Tenant incorreto] RLS bloqueia acesso direto mesmo com bug na aplicação', () => {
    it('toda tabela com tenant_id: SELECT sem filtro só vê A; sem app.tenant_id falha', async () => {
      const tables = await tenantTables(db);
      expect(tables).toEqual(
        expect.arrayContaining(['audit_logs', 'membership_departments', 'outbox_events']),
      );
      for (const table of tables) {
        for (const role of ['cf_app', 'cf_worker'] as const) {
          const foreign = await rawAs(db, role, A, (client) =>
            client.query<{ total: string }>(
              `SELECT count(*)::text AS total FROM ${table} WHERE tenant_id IS DISTINCT FROM $1`,
              [A],
            ),
          );
          expect({ table, role, total: foreign.rows[0]?.total }).toEqual({
            table,
            role,
            total: '0',
          });
          await expect(
            rawAs(db, role, null, (client) => client.query(`SELECT 1 FROM ${table} LIMIT 1`)),
          ).rejects.toThrow(/app\.tenant_id|permission denied/);
        }
      }
    });

    it('INSERT com tenant_id de B é recusado; UPDATE e DELETE em linhas de B não afetam nada', async () => {
      const selectAll = await rawAs(db, 'cf_app', A, (client) =>
        client.query<{ job_title: string }>('SELECT job_title FROM tenant_memberships'),
      );
      expect(new Set(selectAll.rows.map((row) => row.job_title))).toEqual(new Set(['LEAK-A']));

      await expect(
        rawAs(db, 'cf_app', A, (client) =>
          client.query(
            `INSERT INTO tenant_memberships (id, tenant_id, user_id) VALUES ($1, $2, $3)`,
            [newId(), B, BRUNO],
          ),
        ),
      ).rejects.toThrow('new row violates row-level security policy');

      const update = await rawAs(db, 'cf_app', A, (client) =>
        client.query(`UPDATE tenant_memberships SET job_title = 'x' WHERE tenant_id = $1`, [B]),
      );
      expect(update.rowCount).toBe(0);
      const remove = await rawAs(db, 'cf_app', A, (client) =>
        client.query('DELETE FROM membership_departments WHERE tenant_id = $1', [B]),
      );
      expect(remove.rowCount).toBe(0);
      // Mover uma linha de A para B também é barrado (WITH CHECK).
      await expect(
        rawAs(db, 'cf_app', A, (client) =>
          client.query('UPDATE tenant_memberships SET tenant_id = $1 WHERE id = $2', [B, BRUNO_A]),
        ),
      ).rejects.toThrow(/row-level security|violates foreign key/);
    });

    it('pelo cliente da aplicação: extensão injeta o tenant e o filtro; o tenant B nunca aparece', async () => {
      const seen = await asTenant(A, () =>
        app.$tenantTransaction(
          async (tx) => ({
            all: await tx.tenantMembership.findMany({ select: { id: true, jobTitle: true } }),
            fromB: await tx.tenantMembership.findUnique({ where: { id: CARLA_B } }),
            count: await tx.membershipDepartment.count(),
          }),
          { readOnly: true },
        ),
      );
      expect(new Set(seen.all.map((row) => row.jobTitle))).toEqual(new Set(['LEAK-A']));
      expect(seen.fromB).toBeNull();
      expect(seen.count).toBe(1);

      const updated = await asTenant(A, () =>
        app.$tenantTransaction((tx) =>
          tx.tenantMembership.updateMany({ data: { jobTitle: 'LEAK-A' }, where: { id: CARLA_B } }),
        ),
      );
      expect(updated.count).toBe(0);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await expect(
        asTenant(A, () =>
          app.$tenantTransaction((tx) => tx.tenantMembership.findMany({ where: { tenantId: B } })),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    });

    it('FK composta rejeita referência cruzada: 422 REFERENCE_NOT_FOUND no campo', async () => {
      const attempt = asTenant(A, () =>
        app.$tenantTransaction((tx) =>
          tx.membershipDepartment.create({
            data: { id: newId(), tenantId: A, membershipId: CARLA_B, departmentId: DEPT_A },
          }),
        ),
      );
      await expect(attempt).rejects.toMatchObject({
        status: 422,
        code: 'VALIDATION_ERROR',
        errors: [expect.objectContaining({ field: 'membershipId', code: 'REFERENCE_NOT_FOUND' })],
      });
      const [b] = await db.admin<{ total: string }>(
        'SELECT count(*)::text AS total FROM membership_departments WHERE tenant_id = $1',
        [B],
      );
      expect(b?.total).toBe('1');
    });
  });

  describe('[Permissão] papel da aplicação não contorna RLS', () => {
    it('cf_app/cf_worker sem BYPASSRLS e não donos de nenhuma tabela', async () => {
      const roles = await db.admin<{ rolname: string; rolbypassrls: boolean; owns: string }>(`
        SELECT r.rolname, r.rolbypassrls,
               (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)::text AS owns
          FROM pg_roles r WHERE r.rolname IN ('cf_app', 'cf_worker', 'cf_platform') ORDER BY 1`);
      expect(roles).toEqual([
        { rolname: 'cf_app', rolbypassrls: false, owns: '0' },
        { rolname: 'cf_platform', rolbypassrls: false, owns: '0' },
        { rolname: 'cf_worker', rolbypassrls: false, owns: '0' },
      ]);
    });

    it('cf_relay tem privilégios apenas em outbox_events', async () => {
      const grants = await db.admin<{ table_name: string; privilege_type: string }>(`
        SELECT table_name, privilege_type FROM information_schema.role_table_grants
         WHERE grantee = 'cf_relay' ORDER BY 1, 2`);
      expect(grants).toEqual([
        { table_name: 'outbox_events', privilege_type: 'SELECT' },
        { table_name: 'outbox_events', privilege_type: 'UPDATE' },
      ]);
    });

    it('cf_platform não lê nenhuma tabela de negócio; em audit/outbox só vê registros de plataforma', async () => {
      for (const table of ['tenant_memberships', 'membership_departments', 'users']) {
        await expect(
          rawAs(db, 'cf_platform', NO_TENANT, (client) => client.query(`SELECT 1 FROM ${table}`)),
        ).rejects.toThrow(/permission denied/);
      }
      const visible = await rawAs(db, 'cf_platform', NO_TENANT, async (client) => ({
        audit: (await client.query('SELECT tenant_id FROM audit_logs WHERE tenant_id IS NOT NULL'))
          .rowCount,
        outbox: (await client.query("SELECT 1 FROM outbox_events WHERE aggregate_type <> 'Tenant'"))
          .rowCount,
      }));
      expect(visible).toEqual({ audit: 0, outbox: 0 });
    });

    it('tenants: a aplicação lê só as colunas não sensíveis; escrita só pelo cf_platform', async () => {
      const status = await rawAs(db, 'cf_app', null, (client) =>
        client.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [A]),
      );
      expect(status.rows).toEqual([{ status: 'ACTIVE' }]);
      for (const column of ['plan', 'suspension_reason', 'suspended_at']) {
        await expect(
          rawAs(db, 'cf_app', null, (client) => client.query(`SELECT ${column} FROM tenants`)),
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        rawAs(db, 'cf_app', null, (client) =>
          client.query("UPDATE tenants SET name = 'x' WHERE id = $1", [A]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('leituras entre tenants controladas (FA-05) e RLS padrão de tabela nova', () => {
    it('cf_find_invitation: só pelo cf_platform, colunas mínimas, hash em formato fixo', async () => {
      await expect(
        rawAs(db, 'cf_app', A, (client) =>
          client.query('SELECT * FROM cf_find_invitation($1)', [INVITE_HASH]),
        ),
      ).rejects.toThrow(/permission denied/);
      const found = await rawAs(db, 'cf_platform', NO_TENANT, (client) =>
        client.query('SELECT * FROM cf_find_invitation($1)', [INVITE_HASH]),
      );
      expect(found.fields.map((field) => field.name)).toEqual([
        'membership_id',
        'tenant_id',
        'tenant_name',
        'tenant_status',
        'user_id',
        'membership_status',
        'invite_expires_at',
      ]);
      expect(found.rows).toEqual([
        expect.objectContaining({
          membership_id: CARLA_B,
          tenant_id: B,
          membership_status: 'INVITED',
        }),
      ]);
      const malformed = await rawAs(db, 'cf_platform', NO_TENANT, (client) =>
        client.query("SELECT * FROM cf_find_invitation('%')"),
      );
      expect(malformed.rowCount).toBe(0);
    });

    it('cf_apply_tenant_rls aplica ENABLE + FORCE + tenant_isolation e recusa tabela sem tenant_id', async () => {
      await db.admin(`
        SET ROLE cf_owner;
        CREATE TABLE probe_items (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        SELECT cf_apply_tenant_rls('probe_items');
        SELECT cf_apply_tenant_rls('probe_items');
        RESET ROLE;`);
      const [table] = await db.admin<{ rls: boolean; forced: boolean; policies: string }>(`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS forced,
               (SELECT string_agg(polname, ',') FROM pg_policy WHERE polrelid = c.oid) AS policies
          FROM pg_class c WHERE relname = 'probe_items'`);
      expect(table).toEqual({ rls: true, forced: true, policies: 'tenant_isolation' });
      await expect(
        db.admin(`SET ROLE cf_owner;
          CREATE TABLE probe_platform (id uuid PRIMARY KEY);
          SELECT cf_apply_tenant_rls('probe_platform');`),
      ).rejects.toThrow(/não tem a coluna tenant_id/);
      await expect(
        rawAs(db, 'cf_app', A, (client) =>
          client.query("SELECT cf_apply_tenant_rls('outbox_events')"),
        ),
      ).rejects.toThrow(/permission denied/);
      await db.admin('DROP TABLE probe_items');
    });
  });

  describe('SystemDbService (cf_platform — RN-TEN-28)', () => {
    let system: SystemDbService;

    beforeAll(() => {
      system = new SystemDbService({
        url: db.url('cf_platform'),
        maxWaitMs: 2_000,
        transactionTimeoutMs: 10_000,
        statementTimeoutMs: 5_000,
      });
    });

    afterAll(async () => {
      await system.onModuleDestroy();
    });

    it('escreve em tenants, grava auditoria de plataforma e eventos do agregado Tenant', async () => {
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await system.run(
        'TENANT_LIFECYCLE',
        async (tx) => {
          await tx.tenant.update({ where: { id: B }, data: { plan: 'ENTERPRISE' } });
          await tx.$executeRaw`
            INSERT INTO audit_logs (id, occurred_at, tenant_id, actor_type, action, category, result, row_hash)
            VALUES (${newId()}::uuid, now(), NULL, 'PLATFORM_OPERATOR', 'tenant.activate', 'CONFIGURATION', 'SUCCESS', ${'e'.repeat(64)})`;
          await tx.$executeRaw`
            INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata)
            VALUES (${newId()}::uuid, ${B}::uuid, 'TenantActivated', 'tenant.activated', 'Tenant', ${B}::uuid, '{}', '{}')`;
        },
        { caller: 'tenancy-foundation.spec' },
      );
      const [tenant] = await db.admin<{ plan: string }>('SELECT plan FROM tenants WHERE id = $1', [
        B,
      ]);
      expect(tenant?.plan).toBe('ENTERPRISE');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'system_db.call',
          reason: 'TENANT_LIFECYCLE',
          caller: 'tenancy-foundation.spec',
          outcome: 'ok',
        }),
        'system_db.call',
      );

      const platformRecords = await system.run(
        'PLATFORM_AUDIT',
        (tx) => tx.$queryRaw<{ action: string }[]>`SELECT action FROM audit_logs`,
        { caller: 'tenancy-foundation.spec', readOnly: true },
      );
      expect(platformRecords.map((row) => row.action)).toEqual(['tenant.activate']);
    });

    it('evento de outro agregado e leitura de dados de tenant são recusados', async () => {
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await expect(
        system.run(
          'TENANT_PROVISIONING',
          (tx) => tx.$executeRaw`
            INSERT INTO outbox_events (id, tenant_id, event_type, routing_key, aggregate_type, aggregate_id, payload, metadata)
            VALUES (${newId()}::uuid, ${A}::uuid, 'ProcessCreated', 'process.created', 'Process', ${newId()}::uuid, '{}', '{}')`,
          { caller: 'tenancy-foundation.spec' },
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        system.run('TENANT_ENUMERATION', (tx) => tx.$queryRaw`SELECT id FROM tenant_memberships`, {
          caller: 'tenancy-foundation.spec',
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('trabalho sobre dados de um tenant reabre a TenantTransaction daquele tenant (FA-02)', async () => {
      const tenants = await system.run(
        'TENANT_ENUMERATION',
        (tx) =>
          tx.tenant.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
        { caller: 'tenancy-foundation.spec', readOnly: true },
      );
      expect(tenants.map((tenant) => tenant.id)).toEqual([A, B]);
      const transaction = new TenantTransaction(app);
      const perTenant = await runAsSystem({ name: 'Job de teste', tenantId: null }, () =>
        Promise.all(
          tenants.map((tenant) =>
            transaction.runForTenant(tenant.id, (tx) => tx.tenantMembership.count()),
          ),
        ),
      );
      expect(perTenant).toEqual([2, 1]);
    });
  });

  describe('catálogo (RN-TEN-25/27 · meta-verificação do CI)', () => {
    it('todo modelo de tenant do Prisma corresponde a uma tabela com RLS', async () => {
      const tables = await tenantTables(db);
      expect(tables.length).toBe(TENANT_SCOPED_MODELS.length);
    });

    it('toda FK entre tabelas de tenant começa por tenant_id e toda tabela de negócio tem UNIQUE (tenant_id, id)', async () => {
      const fks = await db.admin<{ conname: string }>(`
        SELECT k.conname FROM pg_constraint k
        JOIN pg_attribute s ON s.attrelid = k.conrelid AND s.attname = 'tenant_id'
        JOIN pg_attribute d ON d.attrelid = k.confrelid AND d.attname = 'tenant_id'
        WHERE k.contype = 'f' AND k.conkey[1] <> s.attnum`);
      expect(fks).toEqual([]);
      const withoutKey = await db.admin<{ relname: string }>(`
        SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
          -- Associação sem \`id\` (lista fechada de tools/ci/lib/migrations.ts — multi-tenancy.md §14).
          AND c.relname <> 'process_tags'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.oid AND i.indisunique AND i.indnatts = 2
              AND i.indkey[0] = a.attnum
              AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id'))`);
      expect(withoutKey).toEqual([]);
    });
  });
});
