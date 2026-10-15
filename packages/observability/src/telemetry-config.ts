import { LOG_LEVELS, PRODUCTION_FORBIDDEN_LEVELS } from './logger.js';
import type { LogLevel, ServiceName } from './logger.js';

/*
 * Variáveis de observabilidade comuns a web, api e worker (story US-084 — Campos ·
 * architecture.md §10.2). Função pura: cada app passa o ambiente lido no seu módulo de
 * configuração (RN-FND-06 — `process.env` só em `src/config/**`).
 */

export const OTEL_SERVICE_NAMES = {
  web: 'contrataflow-web',
  api: 'contrataflow-api',
  worker: 'contrataflow-worker',
} as const satisfies Record<ServiceName, string>;

/** Ambientes em que o Collector é obrigatório (fora deles, sem endpoint, o SDK não sobe). */
const ENDPOINT_REQUIRED_ENVS = new Set(['staging', 'production']);

export interface TelemetryConfig {
  readonly service: ServiceName;
  readonly serviceName: (typeof OTEL_SERVICE_NAMES)[ServiceName];
  /** `APP_ENV` — também o `deployment.environment.name`. */
  readonly environment: string;
  readonly production: boolean;
  readonly version: string;
  readonly logLevel: LogLevel;
  /** `null`: tracing desligado (só fora de staging/produção). */
  readonly endpoint: string | null;
  readonly samplerRatio: number;
}

/** Variável inválida: lista só as chaves, nunca os valores (mesma regra do V-01 da US-080). */
export class TelemetryConfigError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Configuração de observabilidade inválida: ${keys.join(', ')}.`);
    this.name = 'TelemetryConfigError';
  }
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadTelemetryConfig(
  service: ServiceName,
  env: Readonly<Record<string, string | undefined>>,
): TelemetryConfig {
  const invalid: string[] = [];
  const environment = present(env.APP_ENV) ?? 'local';
  const production = present(env.NODE_ENV) === 'production';

  const level = present(env.LOG_LEVEL) ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(level) ? (level as LogLevel) : null;
  if (!logLevel || (production && PRODUCTION_FORBIDDEN_LEVELS.includes(logLevel))) {
    invalid.push('LOG_LEVEL');
  }

  const endpoint = present(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? null;
  if (endpoint ? !isHttpUrl(endpoint) : ENDPOINT_REQUIRED_ENVS.has(environment)) {
    invalid.push('OTEL_EXPORTER_OTLP_ENDPOINT');
  }

  const serviceName = OTEL_SERVICE_NAMES[service];
  const declared = present(env.OTEL_SERVICE_NAME);
  if (declared !== undefined && declared !== serviceName) invalid.push('OTEL_SERVICE_NAME');

  const ratioText = present(env.OTEL_TRACES_SAMPLER_ARG);
  const samplerRatio = ratioText === undefined ? 1 : Number(ratioText);
  if (!Number.isFinite(samplerRatio) || samplerRatio < 0 || samplerRatio > 1) {
    invalid.push('OTEL_TRACES_SAMPLER_ARG');
  }

  if (invalid.length > 0 || !logLevel) throw new TelemetryConfigError(invalid.sort());
  return {
    service,
    serviceName,
    environment,
    production,
    version: present(env.APP_VERSION) ?? '0.0.0+local',
    logLevel,
    endpoint,
    samplerRatio,
  };
}
