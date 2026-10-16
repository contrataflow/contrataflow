import { healthRequestHandler, LivenessProbe, ReadinessProbe } from '@contrataflow/observability';
import type { HealthCheck } from '@contrataflow/observability';
import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { INestApplication, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

/*
 * Health checks da API (US-085 · RN-FND-79..81 · observability.md §6): `/health/live` e
 * `/health/ready`, fora de `/api/v1` e fora do pipeline (sem guards, rate limit nem log automático),
 * acessíveis só pela rede interna/ALB. Cada módulo de infraestrutura registra o *health indicator*
 * da dependência que possui no `HealthRegistry` (PostgreSQL em `shared/database`, Redis em
 * `platform`, JWKS em `identity`), com a criticidade da matriz de §6.2.
 */

/** Timeouts padrão por dependência (HEALTH_CHECK_TIMEOUT_MS sobrescreve). */
export const DEFAULT_CHECK_TIMEOUT_MS = { postgresql: 1_000, redis: 500, http: 1_000 } as const;

/** Registro dos *health indicators* da API (`ReadinessProbe` compartilhado). */
@Injectable()
export class HealthRegistry implements OnModuleInit, OnModuleDestroy {
  readonly readiness: ReadinessProbe;
  readonly liveness: LivenessProbe;
  private readonly checkTimeoutMs: number | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const logger = new Logger('Health');
    const appVersion = config.observability.version;
    this.checkTimeoutMs = config.health.checkTimeoutMs;
    this.readiness = new ReadinessProbe({
      serviceId: 'api',
      appVersion,
      cacheTtlMs: config.health.cacheTtlMs,
      logger: {
        info: (fields, message) => {
          logger.log(fields, message);
        },
        warn: (fields, message) => {
          logger.warn(fields, message);
        },
        error: (fields, message) => {
          logger.error(fields, message);
        },
      },
    });
    this.liveness = new LivenessProbe({ serviceId: 'api', appVersion });
  }

  /** Timeout efetivo de uma dependência: o configurado ou o padrão dela. */
  timeoutFor(kind: keyof typeof DEFAULT_CHECK_TIMEOUT_MS): number {
    return this.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS[kind];
  }

  register(check: HealthCheck): void {
    this.readiness.register(check);
  }

  onModuleInit(): void {
    this.liveness.start();
  }

  onModuleDestroy(): void {
    this.liveness.stop();
  }
}

@Global()
@Module({ providers: [HealthRegistry], exports: [HealthRegistry] })
export class HealthModule {}

/**
 * Monta `/health/live` e `/health/ready` direto no Express, antes do pipeline do Nest: não passam
 * por autenticação, tenant, rate limit, idempotência nem pelo log `http.request.completed`.
 */
export function mountHealthRoutes(app: INestApplication): void {
  let registry: HealthRegistry;
  try {
    registry = app.get(HealthRegistry, { strict: false });
  } catch {
    return;
  }
  const handle = healthRequestHandler({ live: registry.liveness, ready: registry.readiness });
  app.use((request: never, response: never, next: () => void) => {
    if (!handle(request, response)) next();
  });
}
