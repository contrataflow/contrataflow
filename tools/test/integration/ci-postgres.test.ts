// US-079 — estágios "Testes" (suíte tenant leak) e "Migrações" contra PostgreSQL real (exige
// Docker; `pnpm --filter @contrataflow/tools test:integration`). Cada caso usa um contêiner
// efêmero próprio, descartado mesmo em falha.
import { describe, expect, it } from 'vitest';

import { runIsolationSuite } from '../../ci/lib/isolation.js';
import { verifyMigrations } from '../../ci/lib/migrations.js';
import type { Migration } from '../../ci/lib/migrations.js';
import { startPostgres } from '../../ci/lib/postgres.js';
import type { EphemeralPostgres } from '../../ci/lib/postgres.js';

const migration = (name: string, sql: string): Migration => ({
  name,
  file: `apps/api/prisma/migrations/${name}/migration.sql`,
  sql,
  checksum: sql,
});

async function withPostgres<T>(task: (pg: EphemeralPostgres) => Promise<T>): Promise<T> {
  const pg = await startPostgres();
  try {
    return await task(pg);
  } finally {
    await pg.stop();
  }
}

const TENANT_TABLE = `CREATE TABLE organizations (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  UNIQUE (tenant_id, id));
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (tenant_id = current_setting('app.tenant_id')::uuid);`;

describe('[Tenant incorreto] suíte tenant leak no banco', () => {
  it('passa com as migrações do PR e o seed dos tenants A e B', async () => {
    const checks = await withPostgres((pg) =>
      runIsolationSuite(pg, [migration('001_organizacoes', TENANT_TABLE)]),
    );
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'contexto Prefeitura A lendo Prefeitura B',
        'contexto Prefeitura B lendo Prefeitura A',
        'consulta sem app.tenant_id falha fechada',
      ]),
    );
  });

  it('falha com tabela de tenant sem FORCE RLS, FK sem tenant_id e unicidade global', async () => {
    const regression = migration(
      '002_processos',
      `CREATE TABLE processes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  organization_id uuid REFERENCES organizations (id), number text UNIQUE);
ALTER TABLE processes ENABLE ROW LEVEL SECURITY;`,
    );
    const checks = await withPostgres((pg) =>
      runIsolationSuite(pg, [migration('001_organizacoes', TENANT_TABLE), regression]),
    );
    const catalog = checks.find((check) => check.name.startsWith('catálogo'));
    expect(catalog?.ok).toBe(false);
    expect(catalog?.detail).toContain(
      'Tabela public.processes tem tenant_id sem RLS ENABLE + FORCE e política.',
    );
    expect(catalog?.detail).toContain('não inclui tenant_id (FK composta — DEC-081).');
    expect(catalog?.detail).toContain('Unicidade processes_number_key em public.processes');
  });
});

describe('[Falha de banco] migrações do zero e sobre o snapshot da versão publicada', () => {
  it('passam quando o PR só acrescenta migrações compatíveis', async () => {
    const published = [migration('001_organizacoes', TENANT_TABLE)];
    const current = [
      ...published,
      migration('002_nome', 'ALTER TABLE organizations ADD COLUMN name text;'),
    ];
    const checks = await withPostgres((pg) => verifyMigrations(pg, current, published, 'v1.0.0'));
    expect(checks.map((check) => [check.label, check.ok, check.apply.applied])).toEqual([
      ['do zero', true, ['001_organizacoes', '002_nome']],
      ['sobre o snapshot v1.0.0', true, ['002_nome']],
    ]);
  });

  it('migração que só quebra sobre o snapshot falha com o erro nativo do PostgreSQL', async () => {
    // A versão publicada criou a tabela sem `kind`; alguém editou a migração antiga (proibido)
    // e a nova depende disso: do zero passa, sobre o snapshot quebra.
    const published = [migration('001_config', 'CREATE TABLE settings (id int PRIMARY KEY);')];
    const current = [
      migration('001_config', 'CREATE TABLE settings (id int PRIMARY KEY, kind text);'),
      migration('002_indice', 'CREATE INDEX settings_kind ON settings (kind);'),
    ];
    const [zero, snapshot] = await withPostgres((pg) =>
      verifyMigrations(pg, current, published, 'v1.0.0'),
    );
    expect(zero?.ok).toBe(true);
    expect(snapshot?.ok).toBe(false);
    expect(snapshot?.apply.failed?.migration.name).toBe('002_indice');
    expect(snapshot?.apply.failed?.error).toMatch(/ERROR: +column "kind" does not exist/);
  });
});
