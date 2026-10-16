import 'server-only';

import { healthHttpResponse, LivenessProbe, ReadinessProbe } from '@contrataflow/observability';
import type { HealthCheck, HealthLogger } from '@contrataflow/observability';

import type { WebHealthConfig } from '@/config/health';
import { webHealthConfig } from '@/config/health';
import { webTelemetryConfig } from '@/config/telemetry';

import { OidcIdentityProvider } from './auth/oidc-provider';
import { bffLogger } from './logger';
import { bffRuntime } from './runtime';
import type { BffRuntime } from './runtime';

/*
 * `/health/live` e `/health/ready` do web/BFF (US-085 · observability.md §6.1–§6.2), fora de
 * `/api/v1` e bloqueados para a internet pelo listener/WAF. Matriz do web: Redis de sessões
 * CRÍTICO (DEC-131 — sem ele o BFF responde 503); API (vista pelo `/health/live` dela) e
 * descoberta OIDC do Authentik DEGRADÁVEIS (evita falha em cascata; tokens em cache seguem valendo).
 */

const DEFAULT_TIMEOUT_MS = { redis: 500, http: 1_000 } as const;

export interface BffHealth {
  readonly liveness: LivenessProbe;
  readonly readiness: ReadinessProbe;
}

function sessionRedisCheck(
  redis: NonNullable<BffRuntime['sessionRedis']>,
  timeoutMs: number,
): HealthCheck {
  return {
    name: 'redis-sessions',
    measurement: 'responseTime',
    criticality: 'critical',
    timeoutMs,
    probe: async () => {
      await redis.ping();
      return undefined;
    },
  };
}

function apiCheck(runtime: BffRuntime, timeoutMs: number): HealthCheck {
  return {
    name: 'api',
    measurement: 'responseTime',
    criticality: 'degradable',
    timeoutMs,
    probe: async () => {
      const response = await runtime.fetch(`${runtime.config.apiInternalUrl}/health/live`, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      return response.ok ? undefined : { status: 'fail', output: 'unavailable' };
    },
  };
}

function discoveryCheck(identity: OidcIdentityProvider, timeoutMs: number): HealthCheck {
  return {
    name: 'authentik-discovery',
    measurement: 'cacheAge',
    criticality: 'degradable',
    timeoutMs,
    probe: async () => {
      if (identity.discoveryState().ageSeconds === null) await identity.warmUp(timeoutMs);
      const state = identity.discoveryState();
      if (state.ageSeconds === null) return { status: 'fail', output: 'not_loaded' };
      return {
        status: state.lastRefreshFailed ? 'warn' : 'pass',
        observedValue: state.ageSeconds,
        observedUnit: 's',
        ...(state.lastRefreshFailed ? { output: 'stale_cache' as const } : {}),
      };
    },
  };
}

/** Monta as sondas a partir do runtime do BFF (separado do singleton para os testes). */
export function createBffHealth(
  runtime: BffRuntime,
  options: {
    readonly health: Pick<WebHealthConfig, 'cacheTtlMs' | 'checkTimeoutMs'>;
    readonly appVersion: string;
    readonly logger?: HealthLogger;
  },
): BffHealth {
  const timeout = (kind: keyof typeof DEFAULT_TIMEOUT_MS) =>
    options.health.checkTimeoutMs ?? DEFAULT_TIMEOUT_MS[kind];
  const readiness = new ReadinessProbe({
    serviceId: 'web',
    appVersion: options.appVersion,
    cacheTtlMs: options.health.cacheTtlMs,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  if (runtime.sessionRedis)
    readiness.register(sessionRedisCheck(runtime.sessionRedis, timeout('redis')));
  readiness.register(apiCheck(runtime, timeout('http')));
  if (runtime.identity instanceof OidcIdentityProvider) {
    readiness.register(discoveryCheck(runtime.identity, timeout('http')));
  }
  const liveness = new LivenessProbe({ serviceId: 'web', appVersion: options.appVersion }).start();
  return { liveness, readiness };
}

// Em globalThis para sobreviver ao HMR do `next dev` (o cache de 5 s é por processo).
const globalHealth = globalThis as typeof globalThis & { __contrataflowHealth?: BffHealth };

export function bffHealth(): BffHealth {
  globalHealth.__contrataflowHealth ??= createBffHealth(bffRuntime(), {
    health: webHealthConfig(),
    appVersion: webTelemetryConfig().version,
    logger: bffLogger(),
  });
  return globalHealth.__contrataflowHealth;
}

/** Só para testes: descarta as sondas do processo. */
export function resetBffHealthForTests(): void {
  globalHealth.__contrataflowHealth?.liveness.stop();
  delete globalHealth.__contrataflowHealth;
}

function toResponse(health: Parameters<typeof healthHttpResponse>[0]): Response {
  const http = healthHttpResponse(health);
  return new Response(http.body, { status: http.statusCode, headers: http.headers });
}

/** HLT-01: processo e *event loop*, sem dependências. */
export function liveResponse(health: BffHealth = bffHealth()): Response {
  return toResponse(health.liveness.check());
}

/** HLT-02: dependências da matriz do web (cache de 5 s, *single-flight*). */
export async function readyResponse(health: BffHealth = bffHealth()): Promise<Response> {
  return toResponse(await health.readiness.check());
}
