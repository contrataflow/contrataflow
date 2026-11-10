// PostgreSQL e Redis reais para a integração do outbox e das filas no worker (US-082/US-083): Testcontainers com as
// imagens do Compose local, as extensões de infra/postgres/init e as migrações da API aplicadas na
// ordem pelo superusuário (o mesmo SQL do `prisma migrate deploy`).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS = `${REPO_ROOT}apps/api/prisma/migrations`;
const PASSWORD = 'test-only';

/** Mesma imagem do Compose local (e do teste de Redis da API). */
export const REDIS_IMAGE =
  'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

function postgresImage(): string {
  const compose = readFileSync(`${REPO_ROOT}infra/docker-compose.yml`, 'utf8');
  const image = /^\s+image:\s*(pgvector\/pgvector:\S+)\s*$/m.exec(compose)?.[1];
  if (!image) throw new Error('infra/docker-compose.yml sem a imagem do postgres');
  return image;
}

/**
 * Partições mensais de `audit_logs` para relógios fixos: a migração só cria o mês corrente e os dois
 * seguintes (`cf_audit_ensure_partitions(2)`), então um teste com data fixa num mês anterior falha com
 * "no partition of relation audit_logs found for row" (teste dependente do calendário). Aqui a janela
 * vai de 2026-01 ao mês corrente (UTC) + 2, com o mesmo DDL, a mesma RLS e o mesmo gatilho que a função
 * da migração aplica a cada partição, criadas como `cf_owner`. Idempotente.
 */
export const AUDIT_PARTITIONS_FROM = '2026-01-01';

export const ENSURE_AUDIT_PARTITIONS_SQL = `
SET ROLE cf_owner;
DO $do$
DECLARE
  month_start timestamp;
  partition_name text;
BEGIN
  FOR month_start IN
    SELECT generate_series(
      '${AUDIT_PARTITIONS_FROM}'::timestamp,
      date_trunc('month', now() AT TIME ZONE 'UTC') + interval '2 months',
      interval '1 month'
    )
  LOOP
    partition_name := 'audit_logs_' || to_char(month_start, 'YYYY_MM');
    CONTINUE WHEN to_regclass('public.' || partition_name) IS NOT NULL;
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      (month_start AT TIME ZONE 'UTC')::text,
      ((month_start + interval '1 month') AT TIME ZONE 'UTC')::text
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_insert ON public.%I FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      partition_name
    );
    EXECUTE format(
      'CREATE POLICY platform_insert ON public.%I FOR INSERT WITH CHECK (tenant_id IS NULL AND NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL)',
      partition_name
    );
    EXECUTE format(
      'CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.cf_audit_logs_immutable()',
      partition_name
    );
  END LOOP;
END
$do$;
RESET ROLE;
`;

/**
 * O Testcontainers espera 10 s (fixos, sem opção de configuração) para o Docker publicar as portas do
 * contêiner no host. Com o Docker Desktop carregado — vários arquivos de teste subindo contêineres ao
 * mesmo tempo — o Docker demora mais e o `start()` falha com "Timed out after 10000ms while waiting for
 * container ports to be bound to the host". É espera de infraestrutura, não defeito do teste: só essa
 * falha é repetida (3 tentativas); qualquer outra, inclusive do serviço dentro do contêiner, propaga.
 */
const PORTS_NOT_BOUND = 'while waiting for container ports to be bound to the host';

async function startWithPortRetry(
  start: () => Promise<StartedTestContainer>,
  attempts = 3,
): Promise<StartedTestContainer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      const retryable = error instanceof Error && error.message.includes(PORTS_NOT_BOUND);
      if (!retryable || attempt >= attempts) throw error;
    }
  }
}

export type Role =
  'postgres' | 'cf_app' | 'cf_platform' | 'cf_relay' | 'cf_maintenance' | 'cf_worker';

export interface TestPostgres {
  url(role: Role): string;
  /** SQL como superusuário (sem RLS) — preparar e conferir o cenário. */
  admin<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedTestContainer = await startWithPortRetry(() =>
    new GenericContainer(postgresImage())
      .withEnvironment({ POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: 'contrataflow' })
      .withExposedPorts(5432)
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
  );
  const url = (role: Role) =>
    `postgresql://${role}:${PASSWORD}@${container.getHost()}:${String(container.getMappedPort(5432))}/contrataflow`;
  const admin = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const client = new pg.Client({ connectionString: url('postgres') });
    await client.connect();
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.end();
    }
  };

  const extensions = readFileSync(
    `${REPO_ROOT}infra/postgres/init/20-contrataflow-extensions.sql`,
    'utf8',
  )
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');
  await admin(extensions);
  const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await admin(readFileSync(`${MIGRATIONS}/${folder}/migration.sql`, 'utf8'));
  }
  await admin(ENSURE_AUDIT_PARTITIONS_SQL);
  for (const role of ['cf_app', 'cf_platform', 'cf_relay', 'cf_maintenance', 'cf_worker']) {
    await admin(`ALTER ROLE ${role} PASSWORD '${PASSWORD}'`);
  }
  return {
    url,
    admin,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const container = await startWithPortRetry(() =>
    new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
  );
  return {
    url: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface TestMailpit {
  /** `smtp://host:porta` do Mailpit (sem autenticação). */
  readonly smtpUrl: string;
  /** API HTTP do Mailpit (`/api/v1/...`). */
  readonly apiUrl: string;
  stop(): Promise<void>;
}

function mailpitImage(): string {
  const compose = readFileSync(`${REPO_ROOT}infra/docker-compose.yml`, 'utf8');
  const image = /^\s+image:\s*(axllent\/mailpit:\S+)\s*$/m.exec(compose)?.[1];
  if (!image) throw new Error('infra/docker-compose.yml sem a imagem do mailpit');
  return image;
}

/** Mailpit do Compose local: captura os e-mails do `MailProvider` SMTP (US-112). */
export async function startMailpit(): Promise<TestMailpit> {
  const container = await startWithPortRetry(() =>
    new GenericContainer(mailpitImage())
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start(),
  );
  const host = container.getHost();
  return {
    smtpUrl: `smtp://${host}:${String(container.getMappedPort(1025))}`,
    apiUrl: `http://${host}:${String(container.getMappedPort(8025))}`,
    stop: async () => {
      await container.stop();
    },
  };
}
