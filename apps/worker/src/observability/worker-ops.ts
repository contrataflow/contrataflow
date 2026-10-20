import { healthRequestHandler, LivenessProbe, ReadinessProbe } from '@contrataflow/observability';
import type { HealthLogger } from '@contrataflow/observability';
import {
  installMetrics,
  observeReadiness,
  startMetricsServer,
} from '@contrataflow/observability/metrics';

import type { WorkerHealthConfig } from '#config/health.js';
import { redisHealthCheck } from '#shared/cache/redis-health.js';
import { postgresHealthCheck } from '#shared/database/database-health.js';
import { smtpHealthCheck } from '#shared/mail/smtp-health.js';

/*
 * Porta interna de administração do worker (US-085 · observability.md §6.1): `/health/live`,
 * `/health/ready` e `/metrics` em `METRICS_PORT` — o worker não tem HTTP público nem balanceador;
 * readiness `fail` vira alerta (A04). Matriz de §6.2 no worker: PostgreSQL e Redis de filas
 * CRÍTICOS; SMTP degradável. (S3, Gotenberg e ClamAV entram com as stories que trazem os
 * respectivos clientes — US-068/render/scan.)
 */

export interface WorkerOpsOptions {
  readonly health: WorkerHealthConfig;
  readonly appVersion: string;
  readonly environment: string;
  /** Banco do worker (`DATABASE_URL_WORKER`, ou o do relay); `null` = sem check. */
  readonly databaseUrl: string | null;
  /** Redis de filas (`REDIS_URL`); `null` = filas desligadas, sem check. */
  readonly redisUrl: string | null;
  /** `SMTP_URL`; `null` = e-mail desligado, sem check. */
  readonly smtpUrl: string | null;
  readonly logger: HealthLogger;
  /** Interface de escuta (padrão `0.0.0.0` — sub-rede privada). */
  readonly host?: string;
}

export interface RunningWorkerOps {
  readonly port: number;
  readonly readiness: ReadinessProbe;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = { postgresql: 1_000, redis: 500, smtp: 1_000 } as const;

export async function startWorkerOps(options: WorkerOpsOptions): Promise<RunningWorkerOps> {
  const timeout = (kind: keyof typeof DEFAULT_TIMEOUT_MS) =>
    options.health.checkTimeoutMs ?? DEFAULT_TIMEOUT_MS[kind];
  const readiness = new ReadinessProbe({
    serviceId: 'worker',
    appVersion: options.appVersion,
    cacheTtlMs: options.health.cacheTtlMs,
    logger: options.logger,
  });
  const closers: (() => Promise<void>)[] = [];
  if (options.databaseUrl) {
    const postgres = postgresHealthCheck(options.databaseUrl, timeout('postgresql'));
    readiness.register(postgres.check);
    closers.push(() => postgres.close());
  }
  if (options.redisUrl) {
    const redis = redisHealthCheck({
      name: 'redis-queues',
      url: options.redisUrl,
      criticality: 'critical',
      timeoutMs: timeout('redis'),
    });
    readiness.register(redis.check);
    closers.push(() => {
      redis.close();
      return Promise.resolve();
    });
  }
  if (options.smtpUrl) readiness.register(smtpHealthCheck(options.smtpUrl, timeout('smtp')));

  const liveness = new LivenessProbe({ serviceId: 'worker', appVersion: options.appVersion });
  liveness.start();
  const server = await startMetricsServer({
    handle: installMetrics({
      serviceName: 'contrataflow-worker',
      serviceVersion: options.appVersion,
      environment: options.environment,
    }),
    port: options.health.metricsPort,
    ...(options.host ? { host: options.host } : {}),
    extra: healthRequestHandler({ live: liveness, ready: readiness }),
  });
  // Sem balanceador, a readiness do worker vira alerta pela métrica (A04).
  observeReadiness(readiness);
  return {
    port: server.port,
    readiness,
    close: async () => {
      liveness.stop();
      await server.close();
      await Promise.all(closers.map((close) => close()));
    },
  };
}
