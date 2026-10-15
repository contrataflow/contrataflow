import pg from 'pg';

/*
 * Conexões do outbox (US-082 · DEC-072) — único ponto do worker com o driver `pg`
 * (lint `contrataflow/no-prisma-client-outside-database`). O relay usa o papel `cf_relay` (BYPASSRLS, só
 * SELECT/UPDATE em `outbox_events` — RN-FND-56) e a purga, o `cf_maintenance` (só SELECT/DELETE).
 * Duas formas de acesso:
 * - `transaction`: transação curta num pool pequeno (o lote `SKIP LOCKED` + `UPDATE`);
 * - `openSession`: conexão de sessão dedicada, fora de pooler em modo transação, que segura a
 *   trava consultiva de líder e o `LISTEN cf_outbox` (queues.md §5.3).
 */

export interface SqlResult<R> {
  readonly rows: R[];
  readonly rowCount: number | null;
}

/** Consulta parametrizada ($1, $2…) — o único jeito de falar com o banco a partir do relay. */
export interface SqlClient {
  query<R extends object = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
}

export interface RelaySession extends SqlClient {
  /** `true` depois de erro ou fim da conexão (a trava de sessão foi junto). */
  readonly lost: boolean;
  /** `LISTEN <canal>`; `onNotify` roda a cada `NOTIFY` entregue (só após o commit do produtor). */
  listen(channel: string, onNotify: () => void): Promise<void>;
  /** Chamado uma vez quando a conexão cai. */
  onLost(callback: (error?: Error) => void): void;
  close(): Promise<void>;
}

export interface OutboxDatabase {
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
  openSession(): Promise<RelaySession>;
  close(): Promise<void>;
}

export interface OutboxDatabaseOptions {
  readonly url: string;
  /** Conexões de transação por réplica (architecture.md §12.1: `cf_relay` 2 × 2). */
  readonly poolSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** Nome da aplicação em `pg_stat_activity`. */
  readonly applicationName?: string;
}

class PgRelaySession implements RelaySession {
  lost = false;
  private readonly lostCallbacks: ((error?: Error) => void)[] = [];

  constructor(private readonly client: pg.Client) {
    const markLost = (error?: Error) => {
      if (this.lost) return;
      this.lost = true;
      for (const callback of this.lostCallbacks) callback(error);
    };
    client.on('error', (error) => {
      markLost(error);
    });
    client.on('end', () => {
      markLost();
    });
  }

  async query<R extends object>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<R>> {
    const result = await this.client.query<R>(sql, [...params]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async listen(channel: string, onNotify: () => void): Promise<void> {
    this.client.on('notification', (message) => {
      if (message.channel === channel) onNotify();
    });
    await this.client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
  }

  onLost(callback: (error?: Error) => void): void {
    this.lostCallbacks.push(callback);
  }

  async close(): Promise<void> {
    this.lost = true;
    await this.client.end().catch(() => undefined);
  }
}

export function createOutboxDatabase(options: OutboxDatabaseOptions): OutboxDatabase {
  const base = {
    connectionString: options.url,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    application_name: options.applicationName ?? 'contrataflow-outbox-relay',
  };
  const pool = new pg.Pool({ ...base, max: options.poolSize ?? 2 });
  // Erro de conexão ociosa do pool: a próxima transação falha e o laço do relay trata.
  pool.on('error', () => undefined);

  return {
    async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      let broken = false;
      try {
        await connection.query('BEGIN');
        const client: SqlClient = {
          query: async <R extends object>(
            sql: string,
            params: readonly unknown[] = [],
          ): Promise<SqlResult<R>> => {
            const result = await connection.query<R>(sql, [...params]);
            return { rows: result.rows, rowCount: result.rowCount };
          },
        };
        const result = await work(client);
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
    },
    async openSession(): Promise<RelaySession> {
      const client = new pg.Client({ ...base, statement_timeout: 0 });
      // Antes do connect: um erro durante a conexão não pode virar exceção não tratada.
      const session = new PgRelaySession(client);
      await client.connect();
      return session;
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
