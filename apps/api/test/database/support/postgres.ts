// PostgreSQL real para os testes de persistência (US-081): Testcontainers com a mesma imagem do
// Compose local, extensões de infra/postgres/init e as migrações aplicadas por
// `prisma migrate deploy` — o mesmo caminho do deploy (o superusuário faz o papel do migrador).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { createTenantPrismaClient } from '#shared/database/prisma-client.js';
import type { DatabaseSettings, TenantPrismaClient } from '#shared/database/prisma-client.js';

const API_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Imagem do serviço `postgres` do Compose (tag + digest): fonte única com o ambiente local. */
export function postgresImage(): string {
  const compose = readFileSync(`${REPO_ROOT}infra/docker-compose.yml`, 'utf8');
  const image = /^\s+image:\s*(pgvector\/pgvector:\S+)\s*$/m.exec(compose)?.[1];
  if (!image) throw new Error('infra/docker-compose.yml sem a imagem do postgres');
  return image;
}

/** Senha descartável dos papéis de LOGIN, só dentro deste contêiner. */
const PASSWORD = 'test-only';

export type LoginRole = 'cf_app' | 'cf_worker' | 'cf_relay' | 'cf_readonly_report' | 'cf_migrator';

export interface TestDatabase {
  readonly container: StartedTestContainer;
  /** URL de conexão do papel (o superusuário é `postgres`). */
  url(role: LoginRole | 'postgres'): string;
  /** Executa SQL como superusuário (ignora RLS — só para preparar e conferir o cenário). */
  admin<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Cliente Prisma com a `TenantTransaction`, conectado com o papel informado. */
  client(role: LoginRole, overrides?: Partial<DatabaseSettings>): TenantPrismaClient;
  stop(): Promise<void>;
}

const exec = promisify(execFile);

/** Executa a CLI do Prisma em apps/api com o banco informado como migrador. */
export function runPrisma(args: string[], url: string): Promise<{ stdout: string }> {
  const prisma = createRequire(import.meta.url).resolve('prisma/build/index.js');
  return exec(process.execPath, [prisma, ...args], {
    cwd: API_ROOT,
    env: {
      // eslint-disable-next-line contrataflow/no-process-env -- o processo filho herda PATH etc.
      ...process.env,
      DATABASE_MIGRATION_URL: url,
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new GenericContainer(postgresImage())
    .withEnvironment({ POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: 'contrataflow' })
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    // O entrypoint sobe o servidor duas vezes (init e definitivo).
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const url = (role: LoginRole | 'postgres') =>
    `postgresql://${role}:${PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/contrataflow`;

  const admin = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const connection = new pg.Client({ connectionString: url('postgres') });
    await connection.connect();
    try {
      return (await connection.query<T>(sql, params)).rows;
    } finally {
      await connection.end();
    }
  };

  // Extensões do banco da aplicação (sem os metacomandos do psql).
  const extensions = readFileSync(
    `${REPO_ROOT}infra/postgres/init/20-contrataflow-extensions.sql`,
    'utf8',
  )
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  await admin(extensions);
  await runPrisma(['migrate', 'deploy'], url('postgres'));
  // Em produção as senhas vêm do Secrets Manager; a migração cria os papéis sem senha.
  for (const role of ['cf_app', 'cf_worker', 'cf_relay', 'cf_readonly_report', 'cf_migrator']) {
    await admin(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
  }

  const clients: TenantPrismaClient[] = [];
  return {
    container,
    url,
    admin,
    client(role, overrides = {}) {
      const client = createTenantPrismaClient({
        url: url(role),
        poolSize: 4,
        maxWaitMs: 2_000,
        transactionTimeoutMs: 10_000,
        statementTimeoutMs: 5_000,
        ...overrides,
      });
      clients.push(client);
      return client;
    },
    async stop() {
      await Promise.all(clients.map((client) => client.$disconnect()));
      await container.stop();
    },
  };
}

/** Executa `fn` como uma requisição autenticada no tenant (o que os guards fazem na API). */
export function asTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { correlationId: 'test', ip: '127.0.0.1', userAgent: 'vitest' },
    () => {
      if (tenantId !== null) updateRequestContext({ tenantId });
      return fn();
    },
  );
}
