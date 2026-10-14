// pnpm --filter @contrataflow/tools test:tenant-leak — suíte "tenant leak" no banco (V-07).
// Exige Docker: sobe um PostgreSQL efêmero só desta execução e o descarta ao final, mesmo em falha.
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { leakMessage, runIsolationSuite } from './lib/isolation.js';
import { listMigrations } from './lib/migrations.js';
import { startPostgres } from './lib/postgres.js';

const reporter = createReporter();
const started = Date.now();
const pg = await startPostgres();
let failed = 0;
try {
  const checks = await runIsolationSuite(pg, listMigrations(REPO_ROOT));
  for (const check of checks) {
    if (check.ok) {
      reporter.log('info', 'ci.tenant_leak', `${check.name} — ${check.detail}`);
      continue;
    }
    failed += 1;
    reporter.annotate('error', `${leakMessage(check.name)} ${check.detail}`, {
      title: 'Suíte tenant leak',
    });
  }
} finally {
  await pg.stop();
}

reporter.log(
  failed === 0 ? 'info' : 'error',
  failed === 0 ? 'ci.stage_completed' : 'ci.stage_failed',
  `suíte tenant leak: ${failed === 0 ? 'isolamento preservado' : `${failed} verificações falharam`}`,
  { durationSeconds: Math.round((Date.now() - started) / 1000) },
);
process.exitCode = failed === 0 ? 0 : 1;
