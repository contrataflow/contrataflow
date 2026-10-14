// Suíte "tenant leak" do estágio "Testes" (US-079 — RN-FND-24 · V-07 · CA-T-01): roda a cada PR
// num PostgreSQL efêmero com as migrações do PR e o seed dos tenants A e B (US-078), e verifica o
// catálogo (RLS/FK composta/unicidade com tenant_id) e o isolamento direto no banco (papel sem
// BYPASSRLS: contexto A lendo B → 0 linhas; sem contexto → erro). As suítes HTTP por operação do
// OpenAPI (multi-tenancy.md §14) entram na mesma tarefa `test:tenant-leak` com as stories de negócio.
import { applyMigrations, catalogChecksSql, parseCatalogViolations } from './migrations.js';
import type { Migration } from './migrations.js';
import type { EphemeralPostgres } from './postgres.js';
import { seedUsers, TENANTS } from '../../env/seed/dataset.js';
import { buildSeedSql } from '../../env/seed/sql.js';
import type { AuthentikIdentity } from '../../env/seed/sql.js';
import { leakQuerySql, noContextSql } from '../../env/smoke/tenant-leak.js';
import type { LeakCounts } from '../../env/smoke/tenant-leak.js';

export interface IsolationCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Schemas com tabelas de tenant: o real (migrações) e o provisório do seed (US-078). */
export const TENANT_SCHEMAS = ['public', 'dev_seed'] as const;

export function leakMessage(test: string): string {
  return `Isolamento de tenant violado em ${test}.`;
}

/** Identidades sintéticas do Authentik (o CI não depende do IdP para provar o isolamento). */
export function syntheticIdentities(): Map<string, AuthentikIdentity> {
  return new Map(
    seedUsers().map((user, index) => [user.username, { pk: String(index + 1), uuid: user.id }]),
  );
}

export async function runIsolationSuite(
  pg: Pick<EphemeralPostgres, 'psql'>,
  migrations: readonly Migration[],
): Promise<IsolationCheck[]> {
  const checks: IsolationCheck[] = [];

  const applied = await applyMigrations(pg, migrations, 'contrataflow');
  checks.push({
    name: 'migrações do PR aplicadas',
    ok: applied.ok,
    detail: applied.failed
      ? `${applied.failed.migration.name}: ${applied.failed.error}`
      : `${applied.applied.length} migrações`,
  });
  if (!applied.ok) return checks;

  const seed = await pg.psql(buildSeedSql(syntheticIdentities()));
  checks.push({
    name: 'seed dos tenants A e B',
    ok: seed.ok,
    detail: seed.ok ? TENANTS.map((tenant) => tenant.name).join(', ') : seed.stderr,
  });
  if (!seed.ok) return checks;

  const catalog = await pg.psql(catalogChecksSql(TENANT_SCHEMAS));
  const violations = catalog.ok ? parseCatalogViolations(catalog.stdout) : [];
  checks.push({
    name: 'catálogo: RLS ENABLE + FORCE, FK composta e unicidade com tenant_id',
    ok: catalog.ok && violations.length === 0,
    detail: catalog.ok
      ? violations.length === 0
        ? 'sem violações'
        : violations.map((item) => item.message).join(' ')
      : catalog.stderr,
  });

  const [a, b] = TENANTS;
  const someone = seedUsers()[0];
  if (!a || !b || !someone) throw new Error('dataset do seed sem dois tenants');
  for (const [tenant, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const result = await pg.psql(leakQuerySql(tenant.slug, someone.id));
    let detail = result.stderr;
    let ok = false;
    if (result.ok) {
      const counts = JSON.parse(result.stdout) as LeakCounts;
      ok = counts.foreign === 0 && counts.own > 0;
      detail = `${counts.foreign} linhas de ${other.name} visíveis; ${counts.own} próprias`;
    }
    checks.push({ name: `contexto ${tenant.name} lendo ${other.name}`, ok, detail });
  }

  const noContext = await pg.psql(noContextSql());
  checks.push({
    name: 'consulta sem app.tenant_id falha fechada',
    ok: !noContext.ok,
    detail: noContext.ok ? 'a consulta retornou linhas sem contexto de tenant' : 'erro (esperado)',
  });
  return checks;
}
