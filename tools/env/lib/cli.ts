// Montagem comum dos scripts `pnpm env:*`: ambiente validado, Compose, psql, API do Authentik,
// perfis pedidos e tratamento uniforme de erro (código + mensagem, saída 1).

import { createAuthentikApi } from './authentik.js';
import type { AuthentikApi } from './authentik.js';
import { createCompose, projectNameFrom } from './compose.js';
import type { Compose } from './compose.js';
import { loadEnv, parseProfiles, PROFILES, validateEnv } from './env-file.js';
import type { EnvMap, Profile } from './env-file.js';
import { lockFileFor, withLock } from './lock.js';
import { consoleLogger, EnvError } from './log.js';
import type { Logger } from './log.js';
import { createPsql } from './psql.js';
import type { Psql } from './psql.js';
import { REPO_ROOT } from '../../lib/workspace.js';

export interface EnvContext {
  readonly root: string;
  readonly env: EnvMap;
  readonly compose: Compose;
  readonly psql: Psql;
  readonly authentik: AuthentikApi;
  readonly logger: Logger;
}

/** V-01/V-02: valida o `.env` antes de qualquer chamada ao Docker. */
export function createContext(
  root: string = REPO_ROOT,
  logger: Logger = consoleLogger,
): EnvContext {
  const env = loadEnv(root);
  const issues = validateEnv(env);
  if (issues.length > 0) {
    throw new EnvError(
      issues[0]?.code ?? 'ENV_VAR_MISSING',
      issues.map((issue) => issue.message).join('\n'),
    );
  }
  const compose = createCompose(root, undefined, projectNameFrom(env));
  return {
    root,
    env,
    compose,
    psql: createPsql(compose),
    authentik: createAuthentikApi(env),
    logger,
  };
}

/** Perfis de `--profile x[,y]`/`--profile=x`/`--full` somados a COMPOSE_PROFILES do `.env`. */
export function profilesFrom(argv: readonly string[], env: EnvMap): Profile[] {
  const requested = parseProfiles(env.COMPOSE_PROFILES ?? '');
  argv.forEach((arg, index) => {
    if (arg === '--full') requested.push('full');
    else if (arg === '--profile') requested.push(...parseProfiles(argv[index + 1] ?? ''));
    else if (arg.startsWith('--profile=')) requested.push(...parseProfiles(arg.slice(10)));
  });
  const unknown = requested.filter((profile) => !(PROFILES as readonly string[]).includes(profile));
  if (unknown.length > 0) {
    throw new EnvError(
      'ENV_VAR_INVALID',
      `Perfil desconhecido: ${unknown.join(', ')}. Use: ${PROFILES.join(', ')}.`,
    );
  }
  return PROFILES.filter((profile) => requested.includes(profile));
}

/** Tempo limite dos healthchecks: ENV_UP_TIMEOUT_SECONDS (padrão 600 s). */
export function upTimeoutMs(env: EnvMap): number | undefined {
  const raw = env.ENV_UP_TIMEOUT_SECONDS ?? process.env.ENV_UP_TIMEOUT_SECONDS;
  const seconds = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Serializa `env:up`/`env:reset` concorrentes no mesmo checkout ("[Concorrência]"). */
export function withEnvLock<T>(context: EnvContext, task: () => Promise<T>): Promise<T> {
  return withLock(lockFileFor(context.root, 'env'), task, {
    timeoutMs: 30 * 60_000,
    onWait: (pid) => {
      context.logger.step(
        `… outra execução de env:up/env:reset em andamento (PID ${pid}); aguardando.`,
      );
    },
  });
}

export async function runMain(main: () => Promise<void>, logger: Logger = consoleLogger) {
  try {
    await main();
  } catch (error) {
    if (error instanceof EnvError) {
      for (const line of error.message.split('\n')) logger.error(error.code, line);
    } else {
      logger.error('env.unexpected_error', error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
