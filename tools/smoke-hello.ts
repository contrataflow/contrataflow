// pnpm smoke:hello — Gherkin "[Sucesso] Aplicações em estado hello" (US-077).
// Pré-requisito: `pnpm build`. Sobe web (3000), api (4000) e worker a partir dos artefatos de
// build, confere título e idioma da página inicial e o encerramento com código 0 em SIGTERM.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { REPO_ROOT } from './lib/workspace.js';

const IS_WINDOWS = process.platform === 'win32';
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

interface Running {
  readonly name: string;
  readonly child: ChildProcess;
  readonly output: () => string;
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Variáveis obrigatórias da API (US-080 — RN-FND-30). Nem o Redis nem o PostgreSQL precisam estar
 * de pé: o cliente Redis conecta em segundo plano e o pipeline degrada sem ele (CA-T-07); o pool
 * do banco só conecta na primeira transação (US-081).
 */
const API_ENV = {
  DATABASE_URL: 'postgresql://cf_app:devpassword@127.0.0.1:5432/contrataflow',
  REDIS_CACHE_URL: 'redis://127.0.0.1:6380',
  OIDC_ISSUER_URL: 'http://localhost:9080/application/o/contrataflow/',
};

function start(
  name: string,
  cwd: string,
  args: string[],
  ready: RegExp,
  extraEnv: Record<string, string> = {},
): Promise<Running> {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name}: não ficou pronto em ${START_TIMEOUT_MS / 1000}s.\n${output}`));
    }, START_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (ready.test(output)) {
        clearTimeout(timer);
        resolve({ name, child, output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name}: encerrou antes de ficar pronto (código ${code}).\n${output}`));
    });
  });
}

/** Envia SIGTERM e devolve o código de saída (no Windows o sinal encerra o processo à força). */
function stop({ name, child }: Running): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name}: não encerrou em ${STOP_TIMEOUT_MS / 1000}s após SIGTERM.`));
    }, STOP_TIMEOUT_MS);
    child.removeAllListeners('exit');
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

async function checkNestApp(name: 'api' | 'worker', ready: RegExp): Promise<Check[]> {
  const cwd = path.join(REPO_ROOT, 'apps', name);
  const running = await start(
    name,
    cwd,
    ['--enable-source-maps', 'dist/main.js'],
    ready,
    name === 'api' ? API_ENV : {},
  );
  const checks: Check[] = [{ name: `${name}: inicializa sem erros`, ok: true, detail: 'pronto' }];
  const code = await stop(running);
  checks.push(
    IS_WINDOWS
      ? {
          name: `${name}: encerra com código 0 em SIGTERM`,
          ok: true,
          detail: 'não verificável no Windows (sem SIGTERM); coberto por verify:fresh-clone',
        }
      : {
          name: `${name}: encerra com código 0 em SIGTERM`,
          ok: code === 0,
          detail: `código ${code}`,
        },
  );
  return checks;
}

async function checkWeb(): Promise<Check[]> {
  const cwd = path.join(REPO_ROOT, 'apps', 'web');
  const nextBin = createRequire(path.join(cwd, 'package.json')).resolve('next/dist/bin/next');
  const running = await start('web', cwd, [nextBin, 'start', '--port', '3000'], /Ready in/);
  try {
    const response = await fetch('http://localhost:3000/');
    const html = await response.text();
    return [
      {
        name: 'web: responde em http://localhost:3000',
        ok: response.ok,
        detail: `HTTP ${response.status}`,
      },
      {
        name: 'web: título "ContrataFlow"',
        ok: html.includes('<title>ContrataFlow</title>'),
        detail: /<title>[^<]*<\/title>/.exec(html)?.[0] ?? 'sem <title>',
      },
      {
        name: 'web: lang "pt-BR"',
        ok: /<html[^>]*\slang="pt-BR"/.test(html),
        detail: /<html[^>]*>/.exec(html)?.[0] ?? 'sem <html>',
      },
    ];
  } finally {
    await stop(running).catch(() => undefined);
  }
}

const required = [
  'apps/api/dist/main.js',
  'apps/worker/dist/main.js',
  'apps/web/.next/BUILD_ID',
].filter((file) => !existsSync(path.join(REPO_ROOT, file)));

if (required.length > 0) {
  console.error(`✖ smoke:hello — execute "pnpm build" antes (faltando: ${required.join(', ')}).`);
  process.exitCode = 1;
} else {
  const checks: Check[] = [];
  for (const run of [
    () => checkNestApp('api', /api\.started/),
    () => checkNestApp('worker', /worker\.started/),
    checkWeb,
  ]) {
    try {
      checks.push(...(await run()));
    } catch (error) {
      checks.push({
        name: 'falha ao executar',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const check of checks) {
    console.log(`${check.ok ? '✔' : '✖'} ${check.name} — ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}
