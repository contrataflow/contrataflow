// pnpm secrets:scan [-- --git <log-opts>] — varredura de segredos com gitleaks (DEC-137 · RS-09).
// Sem argumentos varre a árvore de trabalho; com `--git` (estágio Higiene da US-079) varre os
// commits do intervalo, como `--git origin/main..HEAD`, inclusive segredos já apagados depois.
// Mesma configuração (.gitleaks.toml) nos dois casos; a saída cita só arquivo e linha (V-02).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createReporter } from './ci/lib/annotations.js';
import { parseGitleaksReport, secretMessage } from './ci/lib/secrets.js';
import { REPO_ROOT } from './lib/workspace.js';

/** Imagem oficial do gitleaks v8, fixada por digest (atualizada pelo Renovate). */
const GITLEAKS_IMAGE =
  'zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9';

const { values } = parseArgs({ options: { git: { type: 'string' } } });

const reportDir = mkdtempSync(path.join(tmpdir(), 'cf-gitleaks-'));
// O usuário do contêiner pode não ser o dono do diretório temporário (runner Linux).
chmodSync(reportDir, 0o777);
const target = values.git === undefined ? ['dir', '/repo'] : ['git', '/repo'];
const range = values.git === undefined ? [] : [`--log-opts=${values.git}`];

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${REPO_ROOT},target=/repo,readonly`,
    '--mount',
    `type=bind,source=${reportDir},target=/report`,
    // O dono do repositório montado é outro usuário: o Git do contêiner precisa confiar nele.
    '-e',
    'GIT_CONFIG_COUNT=1',
    '-e',
    'GIT_CONFIG_KEY_0=safe.directory',
    '-e',
    'GIT_CONFIG_VALUE_0=*',
    GITLEAKS_IMAGE,
    ...target,
    ...range,
    '--config',
    '/repo/.gitleaks.toml',
    '--redact',
    '--no-banner',
    '--report-format',
    'json',
    '--report-path',
    '/report/gitleaks.json',
  ],
  { stdio: 'inherit' },
);

const reporter = createReporter();
if (result.error) {
  console.error('✖ secrets:scan exige Docker em execução.');
  process.exitCode = 1;
} else {
  let findings: ReturnType<typeof parseGitleaksReport> = [];
  try {
    findings = parseGitleaksReport(readFileSync(path.join(reportDir, 'gitleaks.json'), 'utf8'));
  } catch {
    // Sem relatório: o gitleaks falhou antes de varrer (a saída dele já está acima).
  }
  for (const finding of findings) {
    reporter.annotate('error', secretMessage(finding), {
      file: finding.file,
      line: finding.line,
      title: `gitleaks ${finding.rule}${finding.commit ? ` (${finding.commit})` : ''}`,
    });
  }
  process.exitCode = result.status ?? 1;
}
rmSync(reportDir, { recursive: true, force: true });
