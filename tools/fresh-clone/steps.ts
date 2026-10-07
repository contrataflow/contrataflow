// Executado DENTRO do contêiner node:24-bookworm-slim por `pnpm verify:fresh-clone`.
// Autocontido (só módulos do Node): roda com a remoção de tipos nativa do Node 24, antes do
// `pnpm install`. Cobre o fluxo principal e os cenários [Sucesso], [Falha de banco] e
// [Falha de integração] da US-077.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE = '/src';
const WORK = '/work';
const COLD_LIMIT_S = 600;
const WARM_LIMIT_S = 120;

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.git',
  '.ddesktop',
  '.claude',
  '_work',
  'prototype',
]);

interface StepResult {
  readonly step: string;
  readonly seconds: number;
  readonly status: number | null;
  readonly output: string;
}

const results: StepResult[] = [];
const failures: string[] = [];

function step(label: string, args: string[], options: { expectFailure?: boolean } = {}) {
  console.log(`\n▶ ${label}: pnpm ${args.join(' ')}`);
  const started = Date.now();
  const child = spawnSync('pnpm', args, {
    cwd: WORK,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', TURBO_TELEMETRY_DISABLED: '1', NEXT_TELEMETRY_DISABLED: '1' },
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${child.stdout}${child.stderr}`;
  process.stdout.write(output.split('\n').slice(-25).join('\n'));
  const result: StepResult = {
    step: label,
    seconds: Math.round((Date.now() - started) / 1000),
    status: child.status,
    output,
  };
  results.push(result);
  const failed = options.expectFailure ? child.status === 0 : child.status !== 0;
  if (failed) failures.push(`${label}: código ${child.status}`);
  return result;
}

function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(dir, full)).update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const DETERMINISTIC_OUTPUTS = [
  'packages/types/dist',
  'packages/validation/dist',
  'packages/editor/dist',
  'packages/ui/dist',
  'apps/api/dist',
  'apps/worker/dist',
];

// 1. Clone limpo: copia o código-fonte sem artefatos locais (node_modules, dist, caches).
cpSync(SOURCE, WORK, {
  recursive: true,
  filter: (source) => {
    const name = path.basename(source);
    return !EXCLUDED_DIRS.has(name) && !name.endsWith('.tsbuildinfo') && name !== 'next-env.d.ts';
  },
});
spawnSync('corepack', ['enable'], { stdio: 'inherit' });

// 2. Fluxo principal (sem PostgreSQL, Redis ou rede além do registry no install).
step('install', ['install', '--frozen-lockfile']);
const cold = step('build (frio)', ['build']);
const hashes = DETERMINISTIC_OUTPUTS.map((dir) => hashTree(path.join(WORK, dir)));
const warm = step('build (quente)', ['build']);
step('lint', ['lint']);
step('typecheck', ['typecheck']);
step('test', ['test']);
step('check:versions', ['check:versions']);
step('depcruise', ['depcruise']);
step('smoke:hello', ['smoke:hello']);

// 3. Determinismo: rebuild sem cache produz as mesmas saídas.
step('build (sem cache)', ['turbo', 'run', 'build', '--force']);
const rebuilt = DETERMINISTIC_OUTPUTS.map((dir) => hashTree(path.join(WORK, dir)));
DETERMINISTIC_OUTPUTS.forEach((dir, index) => {
  if (hashes[index] !== rebuilt[index]) failures.push(`build não determinístico: ${dir}`);
});

// 4. Registry indisponível: com store aquecido instala offline; sem store falha explicitamente.
function removeNodeModules(): void {
  const dirs = [
    'node_modules',
    'tools/node_modules',
    ...['apps', 'packages'].flatMap((group) =>
      readdirSync(path.join(WORK, group)).map((name) => path.join(group, name, 'node_modules')),
    ),
  ];
  for (const dir of dirs) rmSync(path.join(WORK, dir), { recursive: true, force: true });
}

removeNodeModules();
step('install offline (store aquecido)', ['install', '--frozen-lockfile', '--offline']);
removeNodeModules();
const offline = step(
  'install offline (store vazio)',
  ['install', '--frozen-lockfile', '--offline', '--store-dir', '/tmp/empty-store'],
  { expectFailure: true },
);
if (!/ERR_PNPM_NO_OFFLINE_(META|TARBALL)/.test(offline.output)) {
  failures.push('install offline sem store não reportou ERR_PNPM_NO_OFFLINE_*');
}

// 5. Limites de tempo (máquina de referência: 8 vCPU, 16 GB, SSD).
const coldTotal = results
  .filter((r) => ['install', 'build (frio)', 'lint', 'typecheck', 'test'].includes(r.step))
  .reduce((sum, r) => sum + r.seconds, 0);
if (coldTotal > COLD_LIMIT_S) failures.push(`clone limpo levou ${coldTotal}s (> ${COLD_LIMIT_S}s)`);
if (warm.seconds > WARM_LIMIT_S) failures.push(`build quente levou ${warm.seconds}s`);
if (!warm.output.includes('FULL TURBO')) failures.push('build quente não foi servido pelo cache');

console.log('\n── Resumo ──────────────────────────────────────────');
for (const r of results)
  console.log(`${r.step.padEnd(34)} ${String(r.seconds).padStart(4)}s  código ${r.status}`);
console.log(
  `clone limpo (install→test)         ${String(coldTotal).padStart(4)}s  (limite ${COLD_LIMIT_S}s)`,
);
console.log(`build frio / quente                ${cold.seconds}s / ${warm.seconds}s`);
console.log(
  `::result:: ${JSON.stringify({ coldTotal, coldBuild: cold.seconds, warmBuild: warm.seconds, failures })}`,
);

if (failures.length > 0) {
  console.error(
    `\n✖ verify:fresh-clone — ${failures.length} falha(s):\n- ${failures.join('\n- ')}`,
  );
  process.exitCode = 1;
} else {
  console.log('\n✔ verify:fresh-clone — clone limpo verificado.');
}
