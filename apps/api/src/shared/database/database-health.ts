import type { HealthCheck } from '@contrataflow/observability';
import { metrics } from '@opentelemetry/api';
import type pg from 'pg';

/*
 * Observação do banco da API (US-085): o *health indicator* do PostgreSQL (crítico na api —
 * observability.md §6.2: `SELECT 1`, timeout de 1 s, sem leitura de dados de negócio) e as métricas
 * do pool (D2 · observability.md §5.2: `db_client_connections_usage{state}`,
 * `db_client_connections_pending_requests`, `db_client_connections_max`), rótulo `pool_name`.
 */

/** Pool `pg` compartilhado pelo Prisma, pelo health check e pelas métricas. */
export const DATABASE_POOL = Symbol('DatabasePool');

export function postgresHealthCheck(pool: Pick<pg.Pool, 'query'>, timeoutMs: number): HealthCheck {
  return {
    name: 'postgresql',
    measurement: 'responseTime',
    criticality: 'critical',
    timeoutMs,
    probe: async () => {
      await pool.query('SELECT 1');
      return undefined;
    },
  };
}

type PoolCounters = Pick<pg.Pool, 'totalCount' | 'idleCount' | 'waitingCount'> & {
  readonly options: { readonly max?: number | undefined };
};

/** Gauges assíncronos do pool (lidos a cada coleta do `/metrics`). */
export function observeDatabasePool(pool: PoolCounters, poolName: string): void {
  const meter = metrics.getMeter('contrataflow-api');
  const usage = meter.createObservableGauge('db_client_connections_usage', {
    description: 'Conexões do pool por estado (used, idle).',
  });
  const pending = meter.createObservableGauge('db_client_connections_pending_requests', {
    description: 'Pedidos aguardando uma conexão livre do pool.',
  });
  const max = meter.createObservableGauge('db_client_connections_max', {
    description: 'Tamanho máximo do pool (DATABASE_POOL_SIZE).',
  });
  meter.addBatchObservableCallback(
    (result) => {
      const attributes = { pool_name: poolName };
      result.observe(usage, pool.totalCount - pool.idleCount, { ...attributes, state: 'used' });
      result.observe(usage, pool.idleCount, { ...attributes, state: 'idle' });
      result.observe(pending, pool.waitingCount, attributes);
      result.observe(max, pool.options.max ?? 10, attributes);
    },
    [usage, pending, max],
  );
}
