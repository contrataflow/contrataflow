import pg from 'pg';

import type { SqlClient, SqlResult } from './outbox-database.js';

/*
 * Banco dos handlers de fila (US-083 · DEC-072 · RN-FND-64): papel `cf_worker` (sem BYPASSRLS).
 * - `tenantTransaction`: `BEGIN` + `set_config('app.tenant_id', $1, true)` — a RLS vale no worker
 *   exatamente como na API (DEC-082); fora do tenant do job nenhuma linha é lida (falha fechada).
 * - `platformTransaction`: sem `app.tenant_id` — só tabelas de plataforma (`tenants`) e auditoria
 *   de plataforma (`tenant_id` nulo).
 * - `withAdvisoryLock`: trava consultiva de SESSÃO numa conexão dedicada do pool, segurada durante
 *   toda a execução agendada (queues.md §12); a queda da conexão libera a trava.
 */

export interface AdvisoryLockResult<T> {
  readonly acquired: boolean;
  readonly result?: T;
}

export interface WorkerDatabase {
  tenantTransaction<T>(tenantId: string, work: (client: SqlClient) => Promise<T>): Promise<T>;
  platformTransaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>>;
  close(): Promise<void>;
}

export interface WorkerDatabaseOptions {
  readonly url: string;
  readonly poolSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
}

function clientOf(connection: pg.PoolClient): SqlClient {
  return {
    query: async <R extends object>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<SqlResult<R>> => {
      const result = await connection.query<R>(sql, [...params]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export function createWorkerDatabase(options: WorkerDatabaseOptions): WorkerDatabase {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolSize ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    application_name: options.applicationName ?? 'contrataflow-worker',
  });
  // Erro de conexão ociosa: a próxima transação falha e o job é classificado como transitório.
  pool.on('error', () => undefined);

  async function transaction<T>(
    tenantId: string | null,
    work: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const connection = await pool.connect();
    let broken = false;
    try {
      await connection.query('BEGIN');
      if (tenantId !== null) {
        await connection.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      }
      const result = await work(clientOf(connection));
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      connection.release(broken);
    }
  }

  return {
    tenantTransaction: (tenantId, work) => transaction(tenantId, work),
    platformTransaction: (work) => transaction(null, work),
    async withAdvisoryLock<T>(key: string, work: () => Promise<T>) {
      const connection = await pool.connect();
      let broken = false;
      try {
        const { rows } = await connection.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [key],
        );
        if (rows[0]?.acquired !== true) return { acquired: false };
        try {
          return { acquired: true, result: await work() };
        } finally {
          await connection
            .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
            .catch(() => {
              // Sem o unlock, a conexão sai do pool: fechar a sessão libera a trava.
              broken = true;
            });
        }
      } finally {
        connection.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
