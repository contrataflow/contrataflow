import { z } from 'zod';

/*
 * Variáveis do outbox no worker (US-082 · DEC-072 · architecture.md §10.2): `DATABASE_URL_RELAY`
 * (papel `cf_relay`) e `REDIS_URL` (Redis das filas). Fora de `local`/`dev`/`test` as duas são
 * obrigatórias; nesses ambientes, ausentes, o relay e o fan-out ficam desligados (o worker sobe
 * sem banco, como nos testes de bootstrap). Único ponto, com `telemetry.ts`, que lê
 * `process.env` (RN-FND-06).
 */

const APP_ENVS = ['local', 'dev', 'test', 'staging', 'production'] as const;
const OPTIONAL_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('local'),
  DATABASE_URL_RELAY: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
});

export interface OutboxRuntimeConfig {
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly relayDatabaseUrl: string;
  readonly redisUrl: string;
}

/** Configuração inválida: o worker não sobe (só os nomes das chaves no log). */
export class OutboxConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração do outbox inválida: ${keys.join(', ')}`);
    this.name = 'OutboxConfigError';
  }
}

/** `null` = relay desligado (permitido só em `local`/`dev`/`test`). */
export function loadOutboxConfig(
  env: Readonly<Record<string, string | undefined>>,
): OutboxRuntimeConfig | null {
  const parsed = schema.safeParse({
    APP_ENV: present(env.APP_ENV),
    DATABASE_URL_RELAY: present(env.DATABASE_URL_RELAY),
    REDIS_URL: present(env.REDIS_URL),
  });
  if (!parsed.success) {
    throw new OutboxConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const {
    APP_ENV: appEnv,
    DATABASE_URL_RELAY: relayDatabaseUrl,
    REDIS_URL: redisUrl,
  } = parsed.data;
  if (relayDatabaseUrl && redisUrl) return { appEnv, relayDatabaseUrl, redisUrl };
  if (OPTIONAL_ENVS.has(appEnv) && !relayDatabaseUrl && !redisUrl) return null;
  const missing = [
    ...(relayDatabaseUrl ? [] : ['DATABASE_URL_RELAY']),
    ...(redisUrl ? [] : ['REDIS_URL']),
  ];
  throw new OutboxConfigError(missing);
}

export function loadOutboxConfigFromProcess(): OutboxRuntimeConfig | null {
  return loadOutboxConfig(process.env);
}
