import { z } from 'zod';

/*
 * Health checks e métricas do web/BFF (US-085 · HLT-01..03): `METRICS_PORT` (porta INTERNA de
 * `/metrics`, nunca atrás do listener público — V-03), `HEALTH_CACHE_TTL_MS` (5 s) e
 * `HEALTH_CHECK_TIMEOUT_MS` (padrão por dependência: 500 ms Redis, 1 s HTTP).
 */

const schema = z.object({
  /** Padrão 9466: api 9464 e worker 9465 (no ambiente local todos rodam no mesmo host). */
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9466),
  HEALTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export interface WebHealthConfig {
  readonly metricsPort: number;
  readonly cacheTtlMs: number;
  /** `null` = timeout padrão de cada dependência. */
  readonly checkTimeoutMs: number | null;
}

export class WebHealthConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração de health/métricas inválida: ${keys.join(', ')}`);
    this.name = 'WebHealthConfigError';
  }
}

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

export function loadWebHealthConfig(
  env: Readonly<Record<string, string | undefined>>,
): WebHealthConfig {
  const parsed = schema.safeParse({
    METRICS_PORT: present(env.METRICS_PORT),
    HEALTH_CACHE_TTL_MS: present(env.HEALTH_CACHE_TTL_MS),
    HEALTH_CHECK_TIMEOUT_MS: present(env.HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!parsed.success) {
    throw new WebHealthConfigError([
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ]);
  }
  return {
    metricsPort: parsed.data.METRICS_PORT,
    cacheTtlMs: parsed.data.HEALTH_CACHE_TTL_MS,
    checkTimeoutMs: parsed.data.HEALTH_CHECK_TIMEOUT_MS ?? null,
  };
}

export function webHealthConfig(): WebHealthConfig {
  return loadWebHealthConfig(process.env);
}
