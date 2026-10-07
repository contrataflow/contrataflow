// pnpm secrets:scan — varredura local de segredos com gitleaks (DEC-137 · RS-09).
// O CI (US-079) roda a mesma configuração (.gitleaks.toml) sobre o histórico do Git.
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './lib/workspace.js';

/** Imagem oficial do gitleaks v8, fixada por digest (atualizada pelo Renovate). */
const IMAGE =
  'zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9';

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${REPO_ROOT},target=/repo,readonly`,
    IMAGE,
    'dir',
    '/repo',
    '--config',
    '/repo/.gitleaks.toml',
    '--redact',
    '--no-banner',
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error('✖ secrets:scan exige Docker em execução.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
