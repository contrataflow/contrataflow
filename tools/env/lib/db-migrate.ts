// `pnpm db:migrate` (US-081 — fluxo principal 1): aplica as migrações do Prisma no PostgreSQL
// local com o papel migrador (`DATABASE_MIGRATION_URL`, o superusuário em dev) e define a senha de
// desenvolvimento dos papéis de LOGIN criados pela migração — em produção as senhas vêm do
// Secrets Manager e nunca passam por aqui. Idempotente: reexecutar não reaplica nada.
import { createRequire } from 'node:module';
import path from 'node:path';

import { composeStatus, readinessOf } from './compose.js';
import type { Compose } from './compose.js';
import type { EnvMap } from './env-file.js';
import { EnvError } from './log.js';
import type { Logger } from './log.js';
import type { Psql } from './psql.js';
import type { CommandResult, RunOptions } from '../../lib/process.js';
import { isolatedEnv, run } from '../../lib/process.js';
import { REPO_ROOT } from '../../lib/workspace.js';

/** Papéis de LOGIN da migração inicial (RN-FND-46); `cf_owner` não faz login. */
export const LOGIN_ROLES = [
  'cf_migrator',
  'cf_app',
  'cf_worker',
  'cf_relay',
  'cf_readonly_report',
] as const;

/** URL do migrador: `DATABASE_MIGRATION_URL` ou o superusuário local do Compose. */
export function migrationUrl(env: EnvMap): string {
  const explicit = env.DATABASE_MIGRATION_URL?.trim();
  if (explicit) return explicit;
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? '');
  return `postgresql://postgres:${password}@localhost:${env.POSTGRES_PORT ?? '5432'}/contrataflow`;
}

/** Senha local (a do `POSTGRES_PASSWORD`) para os papéis que já existem; o SQL vai por stdin. */
export function devPasswordsSql(password: string): string {
  const literal = `'${password.replaceAll("'", "''")}'`;
  const roles = LOGIN_ROLES.map((role) => `'${role}'`).join(', ');
  return `DO $passwords$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[${roles}] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, ${literal});
    END IF;
  END LOOP;
END
$passwords$;`;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => CommandResult;

export interface DbMigrateDeps {
  readonly env: EnvMap;
  readonly compose: Compose;
  readonly psql: Psql;
  readonly logger: Logger;
  readonly runner?: CommandRunner;
}

/** CLI do Prisma instalada em apps/api (a mesma versão do catálogo). */
function prismaCli(): string {
  return createRequire(path.join(REPO_ROOT, 'apps/api/package.json')).resolve(
    'prisma/build/index.js',
  );
}

export async function dbMigrate(deps: DbMigrateDeps): Promise<void> {
  const [postgres] = readinessOf(['postgres'], await composeStatus(deps.compose));
  if (postgres?.readiness !== 'ready') {
    throw new EnvError(
      'ENV_NOT_READY',
      'Suba o ambiente antes: pnpm env:up. (fora do ar: postgres)',
    );
  }

  deps.logger.step('▶ prisma migrate deploy (apps/api/prisma/migrations)');
  const runner = deps.runner ?? run;
  const result = runner(process.execPath, [prismaCli(), 'migrate', 'deploy'], {
    cwd: path.join(REPO_ROOT, 'apps/api'),
    env: isolatedEnv({
      DATABASE_MIGRATION_URL: migrationUrl(deps.env),
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    }),
    timeoutMs: 300_000,
  });
  if (result.status !== 0) {
    throw new EnvError(
      'MIGRATION_FAILED',
      `prisma migrate deploy falhou:\n${result.output.trim()}`,
    );
  }

  const passwords = await deps.psql(devPasswordsSql(deps.env.POSTGRES_PASSWORD ?? ''));
  if (!passwords.ok) {
    throw new EnvError('MIGRATION_FAILED', `Senhas locais dos papéis: ${passwords.stderr}`);
  }
  deps.logger.info(
    'env.db_migrated',
    `Migrações aplicadas; papéis ${LOGIN_ROLES.join(', ')} com a senha local de POSTGRES_PASSWORD.`,
  );
}
