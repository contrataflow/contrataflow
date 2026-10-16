import { z } from 'zod';

/*
 * Porta interna de administração do worker (US-085 · HLT-01..03 · observability.md §6.1):
 * `METRICS_PORT` serve `/health/live`, `/health/ready` e `/metrics` — nunca exposta fora da rede
 * interna; `HEALTH_CACHE_TTL_MS` (5 s) e `HEALTH_CHECK_TIMEOUT_MS` (padrão por dependência).
 */

const schema = z.object({
  /** Padrão 9465: a api usa 9464 e o web 9466 (no ambiente local todos rodam no mesmo host). */
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9465),
  HEALTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export interface WorkerHealthConfig {
  readonly metricsPort: number;
  readonly cacheTtlMs: number;
  /** `null` = timeout padrão de cada dependência (1 s PostgreSQL, 500 ms Redis). */
  readonly checkTimeoutMs: number | null;
}

export class HealthConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração de health/métricas inválida: ${keys.join(', ')}`);
    this.name = 'HealthConfigError';
  }
}

const present = (value: string | undefined) =>
  value === undefined || value.trim() === '' ? undefined : value;

export function loadHealthConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkerHealthConfig {
  const parsed = schema.safeParse({
    METRICS_PORT: present(env.METRICS_PORT),
    HEALTH_CACHE_TTL_MS: present(env.HEALTH_CACHE_TTL_MS),
    HEALTH_CHECK_TIMEOUT_MS: present(env.HEALTH_CHECK_TIMEOUT_MS),
  });
  if (!parsed.success) {
    throw new HealthConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  return {
    metricsPort: parsed.data.METRICS_PORT,
    cacheTtlMs: parsed.data.HEALTH_CACHE_TTL_MS,
    checkTimeoutMs: parsed.data.HEALTH_CHECK_TIMEOUT_MS ?? null,
  };
}

export function loadHealthConfigFromProcess(): WorkerHealthConfig {
  return loadHealthConfig(process.env);
}
