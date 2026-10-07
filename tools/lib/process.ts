import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout + stderr, para procurar códigos de erro. */
  readonly output: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Ambiente sem as variáveis que o pnpm/turbo do processo pai injetam (`npm_config_*`,
 * `PNPM_*`, `TURBO_*`), para que comandos aninhados se comportem como em um terminal limpo.
 */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|turbo_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...extra };
}

function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Executa um comando e devolve a saída. No Windows, comandos do PATH como `pnpm` são shims
 * `.cmd` e exigem shell (a linha é montada com aspas); executáveis com caminho absoluto
 * (ex.: node) rodam sem shell.
 */
export function run(command: string, args: readonly string[], options: RunOptions): CommandResult {
  const common = {
    cwd: options.cwd,
    env: options.env ?? isolatedEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  } as const;
  const result =
    IS_WINDOWS && !path.isAbsolute(command)
      ? spawnSync([command, ...args].map(quote).join(' '), { ...common, shell: true })
      : spawnSync(command, args, common);
  const stdout = result.stdout;
  const stderr = result.stderr;
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}
