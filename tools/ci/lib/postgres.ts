// PostgreSQL efêmero dos estágios "Testes" e "Migrações" (US-079 — FA-02 · Banco de dados): um
// contêiner por execução, com nome próprio, dados em tmpfs e sem porta publicada (o SQL entra por
// `docker exec … psql`), descartado ao final mesmo em falha. A imagem é a mesma do Compose local.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';

import { runCommand } from '../../env/lib/compose.js';
import type { CommandRunner } from '../../env/lib/compose.js';
import { REPO_ROOT } from '../../lib/workspace.js';

export interface PsqlResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EphemeralPostgres {
  readonly name: string;
  readonly psql: (sql: string, options?: { database?: string }) => Promise<PsqlResult>;
  readonly stop: () => Promise<void>;
}

/** Imagem do serviço `postgres` do Compose (tag + digest): fonte única com o ambiente local. */
export function postgresImage(root: string = REPO_ROOT): string {
  const compose = parse(readFileSync(path.join(root, 'infra/docker-compose.yml'), 'utf8')) as {
    services?: { postgres?: { image?: string } };
  };
  const image = compose.services?.postgres?.image;
  if (!image) throw new Error('infra/docker-compose.yml sem services.postgres.image');
  return image;
}

/** Nome único por execução e tentativa (PRs simultâneos nunca compartilham banco). */
export function containerName(env: NodeJS.ProcessEnv = process.env): string {
  const run = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : 'local';
  return `cf-ci-pg-${run}-${randomUUID().slice(0, 8)}`;
}

export interface StartOptions {
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function startPostgres(options: StartOptions = {}): Promise<EphemeralPostgres> {
  const runner = options.runner ?? runCommand;
  const sleep = options.sleep ?? defaultSleep;
  const name = containerName();
  const started = await runner(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      'com.contrataflow.ci=true',
      '-e',
      // Senha descartável de um banco que só existe dentro deste contêiner.
      'POSTGRES_PASSWORD=ci-ephemeral',
      '-e',
      'POSTGRES_DB=contrataflow',
      '--tmpfs',
      '/var/lib/postgresql/data',
      postgresImage(),
    ],
    { cwd: REPO_ROOT },
  );
  if (started.status !== 0) {
    throw new Error(`docker run do PostgreSQL efêmero falhou: ${started.stderr.trim()}`);
  }

  const stop = async () => {
    await runner('docker', ['rm', '-f', name], { cwd: REPO_ROOT });
  };
  const psql: EphemeralPostgres['psql'] = async (sql, psqlOptions = {}) => {
    const result = await runner(
      'docker',
      [
        'exec',
        '-i',
        name,
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        psqlOptions.database ?? 'contrataflow',
        '-f',
        '-',
      ],
      { cwd: REPO_ROOT, input: sql },
    );
    return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };

  // Pronto só depois do init (TCP em 127.0.0.1, como o healthcheck do Compose).
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    const ready = await runner(
      'docker',
      ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'contrataflow'],
      { cwd: REPO_ROOT },
    );
    if (ready.status === 0) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error('PostgreSQL efêmero não ficou pronto no tempo limite.');
    }
    await sleep(1000);
  }

  const extensions = readFileSync(
    path.join(REPO_ROOT, 'infra/postgres/init/20-contrataflow-extensions.sql'),
    'utf8',
  );
  const init = await psql(extensions);
  if (!init.ok) {
    await stop();
    throw new Error(`extensões do banco falharam: ${init.stderr}`);
  }
  return { name, psql, stop };
}
