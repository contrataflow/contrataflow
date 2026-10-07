// pnpm verify:fresh-clone — integração da US-077, reutilizada pelo CI (US-079).
// Copia o repositório para um contêiner node:24-bookworm-slim (sem node_modules, builds ou
// caches) e executa install → build → lint → typecheck → test, smoke dos apps, determinismo do
// build e instalação offline (tools/fresh-clone/steps.ts). Exige Docker.
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './lib/workspace.js';

/** Imagem de referência, fixada por digest (atualizada pelo Renovate — `docker:pinDigests`). */
const IMAGE =
  process.argv.find((arg) => arg.startsWith('--image='))?.slice(8) ??
  'node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
});
if (docker.status !== 0) {
  console.error(
    '✖ verify:fresh-clone exige Docker em execução (no Windows, Docker Desktop com WSL 2).',
  );
  process.exitCode = 1;
} else {
  console.log(`Docker ${docker.stdout.trim()} · imagem ${IMAGE}`);
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--mount',
      `type=bind,source=${REPO_ROOT},target=/src,readonly`,
      '-e',
      'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
      IMAGE,
      'node',
      '/src/tools/fresh-clone/steps.ts',
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
