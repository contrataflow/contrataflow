// pnpm ci:sql-lint — contexto de tenant só por transação (US-081 — RN-FND-44 · V-05).
// Falha a build com `set_config(…, false)` ou `SET app.*` de sessão em migrações e no código.
import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { lintRepository, sqlLintTargets } from './lib/sql-lint.js';

const reporter = createReporter();
const findings = lintRepository(REPO_ROOT);
for (const finding of findings) {
  reporter.annotate('error', finding.message, {
    file: finding.file,
    line: finding.line,
    title: `SQL · ${finding.rule}`,
  });
}
reporter.log(
  findings.length === 0 ? 'info' : 'error',
  findings.length === 0 ? 'ci.sql_lint_passed' : 'ci.sql_lint_failed',
  `Lint de SQL: ${sqlLintTargets(REPO_ROOT).length} arquivos, ${findings.length} usos de contexto de sessão.`,
);
process.exitCode = findings.length === 0 ? 0 : 1;
