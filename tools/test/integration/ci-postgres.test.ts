// US-079 — estágios "Testes" (suíte tenant leak) e "Migrações" contra PostgreSQL real (exige
// Docker; `pnpm --filter @contrataflow/tools test:integration`). Cada caso usa um contêiner
// efêmero próprio, descartado mesmo em falha.
import { describe, expect, it } from 'vitest';

import { runIsolationSuite } from '../../ci/lib/isolation.js';
import { listMigrations, verifyMigrations } from '../../ci/lib/migrations.js';
import type { Migration } from '../../ci/lib/migrations.js';
import { startPostgres } from '../../ci/lib/postgres.js';
import type { EphemeralPostgres } from '../../ci/lib/postgres.js';
import { REPO_ROOT } from '../../lib/workspace.js';

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

/** Migrações reais do repositório (papéis, `cf_owner`…): toda migração nova roda depois delas. */
const FOUNDATION = listMigrations(REPO_ROOT);

/**
 * Tabela de tenant no padrão de multi-tenancy.md §15, criada como `cf_owner` (RN-FND-46). As
 * tabelas sintéticas levam o prefixo `ci_` para nunca colidirem com as reais das migrações
 * (`organizations` e `processes` existem desde a US-101 e a US-001).
 */
function tenantTable(name: string, columns = ''): string {
  return `SET ROLE cf_owner;
CREATE TABLE ${name} (id uuid PRIMARY KEY, tenant_id uuid NOT NULL${columns},
  UNIQUE (tenant_id, id));
ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${name} USING (tenant_id = current_setting('app.tenant_id')::uuid);
RESET ROLE;`;
}

const TENANT_TABLE = tenantTable('ci_organizations');

describe('[Tenant incorreto] suíte tenant leak no banco', () => {
  it('passa com as migrações do PR e o seed dos tenants A e B', async () => {
    const checks = await withPostgres((pg) =>
      runIsolationSuite(pg, [...FOUNDATION, migration('901_organizacoes', TENANT_TABLE)]),
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

  it('falha com tabela de tenant sem FORCE RLS, FK sem tenant_id, unicidade global, tenant_id nulo, tabela sem tenant_id e dono errado', async () => {
    const regression = migration(
      '902_processos',
      `CREATE TABLE ci_processes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  organization_id uuid REFERENCES ci_organizations (id), number text UNIQUE);
ALTER TABLE ci_processes ENABLE ROW LEVEL SECURITY;
SET ROLE cf_owner;
CREATE TABLE ci_notes (id uuid PRIMARY KEY, tenant_id uuid);
ALTER TABLE ci_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ci_notes USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE TABLE ci_logs (id uuid PRIMARY KEY);
RESET ROLE;`,
    );
    const checks = await withPostgres((pg) =>
      runIsolationSuite(pg, [
        ...FOUNDATION,
        migration('901_organizacoes', TENANT_TABLE),
        regression,
      ]),
    );
    const catalog = checks.find((check) => check.name.startsWith('catálogo'));
    expect(catalog?.ok).toBe(false);
    expect(catalog?.detail).toContain(
      'Migração bloqueada: tabela sem RLS — public.ci_processes tem tenant_id sem RLS ENABLE + FORCE e política.',
    );
    expect(catalog?.detail).toContain('Tabela public.ci_notes aceita tenant_id nulo');
    expect(catalog?.detail).toContain('Tabela public.ci_logs sem tenant_id fora da lista fechada');
    expect(catalog?.detail).toContain(
      'Tabela public.ci_processes pertence a postgres, não a cf_owner',
    );
    expect(catalog?.detail).toContain(
      'FK ci_processes_organization_id_fkey em public.ci_processes não começa por tenant_id (FK composta — DEC-081 · RN-TEN-27).',
    );
    // US-100: tabela de negócio sem UNIQUE (tenant_id, id), alvo das FKs compostas.
    expect(catalog?.detail).toContain('Tabela public.ci_processes sem UNIQUE (tenant_id, id)');
    expect(catalog?.detail).toContain('Unicidade ci_processes_number_key em public.ci_processes');
  });
});

describe('[Falha de banco] migrações do zero e sobre o snapshot da versão publicada', () => {
  it('passam quando o PR só acrescenta migrações compatíveis', async () => {
    const published = [...FOUNDATION, migration('901_organizacoes', TENANT_TABLE)];
    const current = [
      ...published,
      migration(
        '902_nome',
        'SET ROLE cf_owner;\nALTER TABLE ci_organizations ADD COLUMN name text;\nRESET ROLE;',
      ),
    ];
    const checks = await withPostgres((pg) => verifyMigrations(pg, current, published, 'v1.0.0'));
    expect(checks.map((check) => [check.label, check.ok, check.apply.applied.at(-1)])).toEqual([
      ['do zero', true, '902_nome'],
      ['sobre o snapshot v1.0.0', true, '902_nome'],
    ]);
    expect(checks[1]?.apply.applied).toEqual(['902_nome']);
  });

  it('migração que só quebra sobre o snapshot falha com o erro nativo do PostgreSQL', async () => {
    // A versão publicada criou a tabela sem `kind`; alguém editou a migração antiga (proibido)
    // e a nova depende disso: do zero passa, sobre o snapshot quebra.
    const published = [...FOUNDATION, migration('901_config', tenantTable('ci_settings'))];
    const current = [
      ...FOUNDATION,
      migration('901_config', tenantTable('ci_settings', ', kind text')),
      migration(
        '902_indice',
        'SET ROLE cf_owner;\nCREATE INDEX ci_settings_kind ON ci_settings (tenant_id, kind);\nRESET ROLE;',
      ),
    ];
    const [zero, snapshot] = await withPostgres((pg) =>
      verifyMigrations(pg, current, published, 'v1.0.0'),
    );
    expect(zero?.ok).toBe(true);
    expect(snapshot?.ok).toBe(false);
    expect(snapshot?.apply.failed?.migration.name).toBe('902_indice');
    expect(snapshot?.apply.failed?.error).toMatch(/ERROR: +column "kind" does not exist/);
  });
});
