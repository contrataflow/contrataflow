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

/**
 * Argumento da linha montada para o shell no Windows, nas regras do `CommandLineToArgvW`: aspas só
 * quando há espaço ou aspas; a aspa interna vira `\"` e as barras imediatamente antes dela (ou da
 * aspa final) são dobradas. Escapar só a aspa fazia `C:\dir com espaço\` engolir a aspa final.
 */
export function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
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
    // O padrão do Node (1 MiB) mata o processo (ENOBUFS) no `git diff` de um lote grande.
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  } as const;
  const result =
    IS_WINDOWS && !path.isAbsolute(command)
      ? spawnSync([command, ...args].map(quoteWindowsArg).join(' '), { ...common, shell: true })
      : spawnSync(command, args, common);
  const stdout = result.stdout;
  const stderr = result.stderr;
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}
