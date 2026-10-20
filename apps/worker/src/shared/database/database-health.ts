import type { HealthCheck } from '@contrataflow/observability';
import pg from 'pg';

/*
 * PostgreSQL no `/health/ready` do worker (US-085 · observability.md §6.2): CRÍTICO — `SELECT 1`
 * numa conexão própria (pool de 1, sem leitura de dados), timeout de 1 s. Sem o banco o worker não
 * processa nada: `fail` gera o alerta de readiness (o worker não tem balanceador).
 */
export function postgresHealthCheck(
  url: string,
  timeoutMs: number,
): { readonly check: HealthCheck; close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: 'cf-worker-health',
  });
  // Conexão ociosa derrubada (banco reiniciado): o pool a descarta; o próximo check reconecta.
  pool.on('error', () => undefined);
  return {
    check: {
      name: 'postgresql',
      measurement: 'responseTime',
      criticality: 'critical',
      timeoutMs,
      probe: async () => {
        await pool.query('SELECT 1');
        return undefined;
      },
    },
    close: () => pool.end(),
  };
}
