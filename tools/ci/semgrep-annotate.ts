// tsx tools/ci/semgrep-annotate.ts <semgrep.json> — anota no PR cada achado do SAST (V-04).
import { existsSync, readFileSync } from 'node:fs';

import { createReporter } from './lib/annotations.js';
import { parseSemgrepJson } from './lib/semgrep.js';

const file = process.argv[2];
const reporter = createReporter();
if (!file || !existsSync(file)) {
  reporter.annotate('error', 'Relatório do Semgrep não encontrado (a varredura não terminou).');
  process.exit(1);
}

const report = parseSemgrepJson(readFileSync(file, 'utf8'));
for (const finding of report.findings) {
  reporter.annotate(finding.level, finding.message, {
    file: finding.file,
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.col === undefined ? {} : { col: finding.col }),
    title: finding.title,
  });
}
for (const error of report.errors) reporter.annotate('error', `Semgrep: ${error}`);
reporter.log(
  report.findings.length === 0 ? 'info' : 'error',
  'ci.sast',
  `Semgrep: ${report.findings.length} achados, ${report.errors.length} erros.`,
);
