// pnpm ci:migrations [--base origin/main] [--snapshot <ref>]
// Estágio "Migrações" (US-079 — RN-FND-25 · V-08 · Gherkin "[Falha de banco]"):
// 1. lint expand/contract e RLS das migrações novas; migrações já publicadas são imutáveis;
// 2. aplica todas do zero num banco vazio;
// 3. aplica sobre o *snapshot* da versão publicada anterior (migrações da última tag `v*`, ou da
//    base) as migrações que o PR acrescenta — a ordem real de um deploy;
// 4. checagens de catálogo de multi-tenancy.md §14 depois de cada aplicação.
// A saída de erro é a nativa do PostgreSQL (psql). Exige Docker.
import { parseArgs } from 'node:util';

import { run } from '../lib/process.js';
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import {
  checkPublished,
  lintMigration,
  listMigrations,
  listMigrationsAtRef,
  newMigrations,
  verifyMigrations,
} from './lib/migrations.js';
import { startPostgres } from './lib/postgres.js';

const { values } = parseArgs({
  options: { base: { type: 'string', default: 'origin/main' }, snapshot: { type: 'string' } },
});

const reporter = createReporter();
const base = values.base;

/** Última versão publicada (tag `v*` alcançável pela base); sem release ainda, a própria base. */
function snapshotRef(): string {
  if (values.snapshot) return values.snapshot;
  const tag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', base], {
    cwd: REPO_ROOT,
  });
  return tag.status === 0 ? tag.stdout.trim() : base;
}

const current = listMigrations(REPO_ROOT);
const published = listMigrationsAtRef(base);
const snapshot = snapshotRef();
const fresh = newMigrations(published, current);

// 1. Lint
const findings = [...checkPublished(published, current), ...fresh.flatMap(lintMigration)];
for (const finding of findings) {
  reporter.annotate(finding.level, finding.message, {
    file: finding.file,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    title: `Migração · ${finding.rule}`,
  });
}
const lintErrors = findings.filter((finding) => finding.level === 'error').length;

if (current.length === 0 && published.length === 0) {
  reporter.annotate(
    'notice',
    'Nenhuma migração ainda (o schema nasce na US-081); nada a aplicar.',
    { title: 'Migrações' },
  );
  process.exit(0);
}

const pg = await startPostgres();
let ok = lintErrors === 0;
try {
  const previous = snapshot === base ? published : listMigrationsAtRef(snapshot);
  for (const check of await verifyMigrations(pg, current, previous, snapshot)) {
    if (check.restoreError !== undefined) {
      reporter.annotate(
        'error',
        `Snapshot ${snapshot} não pôde ser recriado: ${check.restoreError}`,
      );
    } else if (check.apply.failed) {
      // Erro nativo do PostgreSQL (V-08), no arquivo da migração que falhou.
      reporter.annotate('error', check.apply.failed.error, {
        file: check.apply.failed.migration.file,
        title: `Migração falhou (${check.label})`,
      });
    }
    if (check.catalogError) {
      reporter.annotate('error', check.catalogError, { title: `Catálogo (${check.label})` });
    }
    for (const violation of check.violations) {
      reporter.annotate('error', violation.message, { title: `Catálogo (${check.label})` });
    }
    reporter.log(
      check.ok ? 'info' : 'error',
      'ci.migrations',
      `${check.label}: ${check.apply.applied.length} migrações aplicadas.`,
    );
    ok = check.ok && ok;
  }
} finally {
  await pg.stop();
}

reporter.log(
  ok ? 'info' : 'error',
  ok ? 'ci.stage_completed' : 'ci.stage_failed',
  `Migrações: ${current.length} no PR, ${fresh.length} novas, snapshot ${snapshot}.`,
);
process.exitCode = ok ? 0 : 1;
