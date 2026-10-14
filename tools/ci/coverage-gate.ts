// pnpm ci:coverage --base <ref> [--lcov apps/api/coverage/lcov.info]
// Check bloqueante de cobertura do código novo por módulo (US-079 — RN-FND-24).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { REPO_ROOT } from '../lib/workspace.js';
import { createReporter } from './lib/annotations.js';
import { evaluateCoverage, lineRanges, parseLcov } from './lib/coverage.js';
import { changedLines } from './lib/git.js';
import { POLICY_FILE, readPolicy } from './lib/policy.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/main' },
    lcov: { type: 'string', default: 'apps/api/coverage/lcov.info' },
  },
});

const reporter = createReporter();
const policy = readPolicy();
const threshold = policy.coverageThreshold;
const lcovPath = path.join(REPO_ROOT, values.lcov);

const changed = changedLines(values.base, 'HEAD', ['apps/api/src/modules']);
if (![...changed.keys()].some((file) => /\/(domain|application)\//.test(file))) {
  reporter.log('info', 'ci.coverage', 'Nenhuma linha nova em domain/ ou application/.');
  process.exit(0);
}
if (!existsSync(lcovPath)) {
  reporter.annotate(
    'error',
    `Relatório de cobertura não encontrado em ${values.lcov}: rode os testes com cobertura.`,
    { title: 'Cobertura' },
  );
  process.exit(1);
}

const coverage = parseLcov(
  readFileSync(lcovPath, 'utf8'),
  path.dirname(path.dirname(values.lcov)),
  REPO_ROOT,
);
const result = evaluateCoverage(changed, coverage, threshold);
const level = policy.coverageGateEnabled ? 'error' : 'warning';

for (const item of result.modules.filter((module) => !module.passed)) {
  const message = `Cobertura do código novo do módulo ${item.module}: ${item.percent}% (${item.covered}/${item.total} linhas) — mínimo ${threshold}%.`;
  reporter.log('warn', 'ci.coverage_below_threshold', message, {
    module: item.module,
    percent: item.percent,
    threshold,
  });
  reporter.annotate(level, message, { title: 'Cobertura abaixo do mínimo' });
  for (const [file, lines] of item.uncovered) {
    for (const range of lineRanges(lines)) {
      reporter.annotate('warning', 'Linha nova sem cobertura de teste.', {
        file,
        line: range.start,
        title: `Sem cobertura (${range.start}–${range.end})`,
      });
    }
  }
}
for (const file of result.missing) {
  reporter.annotate('warning', 'Arquivo novo sem dados de cobertura (excluído ou só tipos).', {
    file,
  });
}

reporter.summary(
  [
    `### Cobertura do código novo (mínimo ${threshold}% — ${POLICY_FILE})`,
    '| Módulo | Linhas novas cobertas | % | Resultado |',
    '|---|---|---|---|',
    ...result.modules.map(
      (item) =>
        `| ${item.module} | ${item.covered}/${item.total} | ${item.percent}% | ${item.passed ? '✅' : '❌'} |`,
    ),
  ].join('\n'),
);

if (!policy.coverageGateEnabled && !result.passed) {
  reporter.annotate(
    'warning',
    `ci.coverageGateEnabled = false em ${POLICY_FILE}: cobertura abaixo do mínimo não bloqueia (exige decisão registrada da liderança técnica).`,
  );
}
process.exitCode = result.passed || !policy.coverageGateEnabled ? 0 : 1;
