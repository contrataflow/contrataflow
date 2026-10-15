import { z } from 'zod';

/*
 * Variável do consumidor de eventos de vínculo no worker (US-088 · RN-IAM-27): `REDIS_SESSION_URL`
 * (Redis de sessões — crítico, DEC-131), o mesmo que o BFF e a varredura da api usam. Fora de
 * `local`/`dev`/`test` é obrigatória: sem ela, vínculo suspenso/revogado/expirado não encerraria as
 * sessões vivas. Nesses ambientes, ausente, o consumidor fica desligado (as sessões vivem na
 * memória do BFF — US-087 — e não há o que encerrar no Redis). Com `config/outbox.ts`, é o único
 * ponto do worker que lê `process.env` (RN-FND-06).
 */

const APP_ENVS = ['local', 'dev', 'test', 'staging', 'production'] as const;
const OPTIONAL_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

const schema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('local'),
  REDIS_SESSION_URL: z.url({ protocol: /^rediss?$/ }).optional(),
});

export interface SessionsRuntimeConfig {
  readonly appEnv: (typeof APP_ENVS)[number];
  readonly redisUrl: string;
}

/** Configuração inválida: o worker não sobe (só os nomes das chaves no log — a URL tem segredo). */
export class SessionsConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração do Redis de sessões inválida: ${keys.join(', ')}`);
    this.name = 'SessionsConfigError';
  }
}

/** `null` = consumidor desligado (permitido só em `local`/`dev`/`test`). */
export function loadSessionsConfig(
  env: Readonly<Record<string, string | undefined>>,
): SessionsRuntimeConfig | null {
  const parsed = schema.safeParse({
    APP_ENV: present(env.APP_ENV),
    REDIS_SESSION_URL: present(env.REDIS_SESSION_URL),
  });
  if (!parsed.success) {
    throw new SessionsConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const { APP_ENV: appEnv, REDIS_SESSION_URL: redisUrl } = parsed.data;
  if (redisUrl) return { appEnv, redisUrl };
  if (OPTIONAL_ENVS.has(appEnv)) return null;
  throw new SessionsConfigError(['REDIS_SESSION_URL']);
}

export function loadSessionsConfigFromProcess(): SessionsRuntimeConfig | null {
  return loadSessionsConfig(process.env);
}
