import { describe, expect, it } from 'vitest';

import type { Compose } from '../env/lib/compose.js';
import { dbMigrate, devPasswordsSql, LOGIN_ROLES, migrationUrl } from '../env/lib/db-migrate.js';
import type { CommandRunner } from '../env/lib/db-migrate.js';
import { memoryLogger } from '../env/lib/log.js';
import type { Psql } from '../env/lib/psql.js';
import { identityMirrorSql } from '../env/seed/sql.js';
import { REPO_ROOT } from '../lib/workspace.js';

function fakeCompose(postgres: 'healthy' | 'starting'): Compose {
  const stdout = JSON.stringify({
    Service: 'postgres',
    State: 'running',
    Health: postgres,
    ExitCode: 0,
  });
  return { root: REPO_ROOT, run: () => Promise.resolve({ status: 0, stdout, stderr: '' }) };
}

const env = { POSTGRES_PASSWORD: "dev'pass", POSTGRES_PORT: '55432' };

describe('pnpm db:migrate (US-081 — fluxo principal 1)', () => {
  it('URL do migrador: DATABASE_MIGRATION_URL ou o superusuário local do Compose', () => {
    expect(migrationUrl({ DATABASE_MIGRATION_URL: ' postgresql://m@h/db ' })).toBe(
      'postgresql://m@h/db',
    );
    expect(migrationUrl(env)).toBe("postgresql://postgres:dev'pass@localhost:55432/contrataflow");
    expect(migrationUrl({ POSTGRES_PASSWORD: 'a b' })).toBe(
      'postgresql://postgres:a%20b@localhost:5432/contrataflow',
    );
  });

  it('senha local só para os papéis de LOGIN que existem, com literal escapado', () => {
    const sql = devPasswordsSql("dev'pass");
    expect(sql).toContain(
      "ARRAY['cf_migrator', 'cf_app', 'cf_worker', 'cf_relay', 'cf_maintenance', 'cf_readonly_report']",
    );
    expect(sql).toContain("format('ALTER ROLE %I PASSWORD %L', role_name, 'dev''pass')");
    expect(sql).toContain('IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name)');
    expect(LOGIN_ROLES).not.toContain('cf_owner');
  });

  it('aplica as migrações com o migrador e depois define as senhas locais', async () => {
    const calls: { args: readonly string[]; url: string | undefined; cwd: string }[] = [];
    const runner: CommandRunner = (_command, args, options) => {
      calls.push({ args, url: options.env?.DATABASE_MIGRATION_URL, cwd: options.cwd });
      return {
        status: 0,
        stdout: 'All migrations have been successfully applied.',
        stderr: '',
        output: '',
      };
    };
    const scripts: string[] = [];
    const psql: Psql = (sql) => {
      scripts.push(sql);
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    };
    const logger = memoryLogger();
    await dbMigrate({ env, compose: fakeCompose('healthy'), psql, logger, runner });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(-2)).toEqual(['migrate', 'deploy']);
    expect(calls[0]?.args[0]).toMatch(/prisma[\\/]build[\\/]index\.js$/);
    expect(calls[0]?.url).toBe(migrationUrl(env));
    expect(calls[0]?.cwd.replaceAll('\\', '/')).toMatch(/apps\/api$/);
    expect(scripts).toEqual([devPasswordsSql("dev'pass"), identityMirrorSql()]);
    expect(logger.lines.join('\n')).toContain('env.db_migrated');
  });

  it('sem o PostgreSQL de pé, interrompe sem rodar nada (ENV_NOT_READY)', async () => {
    let ran = false;
    const attempt = dbMigrate({
      env,
      compose: fakeCompose('starting'),
      psql: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }),
      logger: memoryLogger(),
      runner: () => {
        ran = true;
        return { status: 0, stdout: '', stderr: '', output: '' };
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'ENV_NOT_READY' });
    expect(ran).toBe(false);
  });

  it('falha da migração ou das senhas vira MIGRATION_FAILED com a saída nativa', async () => {
    const failing: CommandRunner = () => ({
      status: 1,
      stdout: '',
      stderr: 'P3018',
      output: 'Error: P3018 A migration failed to apply.',
    });
    const ok: Psql = () => Promise.resolve({ ok: true, stdout: '', stderr: '' });
    await expect(
      dbMigrate({
        env,
        compose: fakeCompose('healthy'),
        psql: ok,
        logger: memoryLogger(),
        runner: failing,
      }),
    ).rejects.toThrow(/prisma migrate deploy falhou:\s+Error: P3018/);

    const passed: CommandRunner = () => ({ status: 0, stdout: '', stderr: '', output: '' });
    const broken: Psql = () => Promise.resolve({ ok: false, stdout: '', stderr: 'role error' });
    await expect(
      dbMigrate({
        env,
        compose: fakeCompose('healthy'),
        psql: broken,
        logger: memoryLogger(),
        runner: passed,
      }),
    ).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'Senhas locais dos papéis: role error',
    });
  });
});
