import { z } from 'zod';

import type { EmailRuntimeConfig } from './email.js';

/*
 * Variáveis das filas do worker (US-083 · architecture.md §10.2): `REDIS_URL` (Redis das filas,
 * o mesmo do outbox), `DATABASE_URL_WORKER` (papel `cf_worker`, RLS), `DATABASE_URL_MAINTENANCE`
 * (papel `cf_maintenance`, purga do outbox — DEC-072/085), `WORKER_ADMIN_PORT` (porta
 * INTERNA do Bull Board — nunca exposta à internet) e o emissor/audiência do cliente OIDC de
 * operação (`OIDC_ISSUER_URL`, `WORKER_ADMIN_OIDC_AUDIENCE`). Fora de `local`/`dev`/`test`, Redis
 * e os dois bancos são obrigatórios; o painel só sobe com a porta definida e, então, exige o OIDC.
 */

const APP_ENVS = ['local', 'dev', 'test', 'staging', 'production'] as const;
const OPTIONAL_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('local'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  DATABASE_URL_WORKER: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  DATABASE_URL_MAINTENANCE: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  WORKER_ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  OIDC_ISSUER_URL: z.url({ protocol: /^https?$/ }).optional(),
  WORKER_ADMIN_OIDC_AUDIENCE: z.string().min(1).optional(),
});

export interface QueueAdminConfig {
  readonly port: number;
  readonly issuer: string;
  readonly audience: string;
}

export interface QueueRuntimeConfig {
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly redisUrl: string;
  /** `null` = handlers sem acesso ao banco (só em `local`/`dev`/`test`). */
  readonly workerDatabaseUrl: string | null;
  /** Papel `cf_maintenance`; `null` = purga do outbox não registrada (só em `local`/`dev`/`test`). */
  readonly maintenanceDatabaseUrl?: string | null;
  /** `null` = Bull Board desligado. */
  readonly admin: QueueAdminConfig | null;
  /**
   * E-mail transacional (US-112 — `loadEmailConfig`, acrescentado pelo `main`); ausente/`null` =
   * `EmailSender` não registrado (os jobs de `email` esperam na fila).
   */
  readonly email?: EmailRuntimeConfig | null;
}

export class QueuesConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração das filas inválida: ${keys.join(', ')}`);
    this.name = 'QueuesConfigError';
  }
}

/** `null` = filas desligadas (permitido só em `local`/`dev`/`test`, sem `REDIS_URL`). */
export function loadQueuesConfig(
  env: Readonly<Record<string, string | undefined>>,
): QueueRuntimeConfig | null {
  const parsed = schema.safeParse({
    APP_ENV: present(env.APP_ENV),
    REDIS_URL: present(env.REDIS_URL),
    DATABASE_URL_WORKER: present(env.DATABASE_URL_WORKER),
    DATABASE_URL_MAINTENANCE: present(env.DATABASE_URL_MAINTENANCE),
    WORKER_ADMIN_PORT: present(env.WORKER_ADMIN_PORT),
    OIDC_ISSUER_URL: present(env.OIDC_ISSUER_URL),
    WORKER_ADMIN_OIDC_AUDIENCE: present(env.WORKER_ADMIN_OIDC_AUDIENCE),
  });
  if (!parsed.success) {
    throw new QueuesConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const data = parsed.data;
  const optional = OPTIONAL_ENVS.has(data.APP_ENV);
  if (!data.REDIS_URL) {
    if (optional) return null;
    throw new QueuesConfigError(['REDIS_URL']);
  }
  if (!optional) {
    const missing = [
      ...(data.DATABASE_URL_WORKER ? [] : ['DATABASE_URL_WORKER']),
      ...(data.DATABASE_URL_MAINTENANCE ? [] : ['DATABASE_URL_MAINTENANCE']),
    ];
    if (missing.length > 0) throw new QueuesConfigError(missing);
  }
  let admin: QueueAdminConfig | null = null;
  if (data.WORKER_ADMIN_PORT !== undefined) {
    const missing = [
      ...(data.OIDC_ISSUER_URL ? [] : ['OIDC_ISSUER_URL']),
      ...(data.WORKER_ADMIN_OIDC_AUDIENCE ? [] : ['WORKER_ADMIN_OIDC_AUDIENCE']),
    ];
    if (missing.length > 0) throw new QueuesConfigError(missing);
    admin = {
      port: data.WORKER_ADMIN_PORT,
      issuer: data.OIDC_ISSUER_URL ?? '',
      audience: data.WORKER_ADMIN_OIDC_AUDIENCE ?? '',
    };
  }
  return {
    appEnv: data.APP_ENV,
    redisUrl: data.REDIS_URL,
    workerDatabaseUrl: data.DATABASE_URL_WORKER ?? null,
    maintenanceDatabaseUrl: data.DATABASE_URL_MAINTENANCE ?? null,
    admin,
  };
}

export function loadQueuesConfigFromProcess(): QueueRuntimeConfig | null {
  return loadQueuesConfig(process.env);
}

const cliSchema = z.object({
  CF_OPS_TOKEN: z.string().min(1),
  OIDC_ISSUER_URL: z.url({ protocol: /^https?$/ }),
  WORKER_ADMIN_OIDC_AUDIENCE: z.string().min(1),
  DATABASE_URL_RELAY: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
});

export interface QueueCliConfig {
  readonly queues: QueueRuntimeConfig;
  readonly token: string;
  readonly issuer: string;
  readonly audience: string;
  /** Papel `cf_relay` (republicação de eventos `FAILED` do outbox). */
  readonly relayDatabaseUrl: string | null;
}

/** CLI de reprocessamento (FA-04): token do operador, Redis e banco obrigatórios. */
export function loadQueueCliConfig(
  env: Readonly<Record<string, string | undefined>>,
): QueueCliConfig {
  const queues = loadQueuesConfig(env);
  const parsed = cliSchema.safeParse({
    CF_OPS_TOKEN: present(env.CF_OPS_TOKEN),
    OIDC_ISSUER_URL: present(env.OIDC_ISSUER_URL),
    WORKER_ADMIN_OIDC_AUDIENCE: present(env.WORKER_ADMIN_OIDC_AUDIENCE),
    DATABASE_URL_RELAY: present(env.DATABASE_URL_RELAY),
  });
  const missing = [
    ...(queues ? [] : ['REDIS_URL']),
    ...(queues?.workerDatabaseUrl ? [] : ['DATABASE_URL_WORKER']),
    ...(parsed.success ? [] : parsed.error.issues.map((i) => String(i.path[0]))),
  ];
  if (!queues || !parsed.success || missing.length > 0) {
    throw new QueuesConfigError([...new Set(missing)]);
  }
  return {
    queues,
    token: parsed.data.CF_OPS_TOKEN,
    issuer: parsed.data.OIDC_ISSUER_URL,
    audience: parsed.data.WORKER_ADMIN_OIDC_AUDIENCE,
    relayDatabaseUrl: parsed.data.DATABASE_URL_RELAY ?? null,
  };
}

export function loadQueueCliConfigFromProcess(): QueueCliConfig {
  return loadQueueCliConfig(process.env);
}
