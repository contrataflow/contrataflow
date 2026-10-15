import type { SqlClient } from '#shared/database/outbox-database.js';

import type { OutboxRecord } from './outbox-record.js';

/*
 * SQL do relay e da purga sobre `outbox_events` (queues.md §5.3/§4.8). Sempre no `SqlClient` da
 * transação do ciclo — as travas `FOR UPDATE` duram até o COMMIT/ROLLBACK dela.
 */

/** Tamanho máximo de `last_error` (resumido, nunca com payload — Logs da US-082). */
const LAST_ERROR_MAX = 500;

export class OutboxRepository {
  /**
   * Até `limit` linhas `PENDING` vencidas, na ordem dos fatos, travadas para esta transação;
   * linhas já travadas por outra transação são puladas (SKIP LOCKED — RN-FND-55).
   */
  async claimPendingBatch(client: SqlClient, limit: number): Promise<OutboxRecord[]> {
    const { rows } = await client.query<OutboxRecord>(
      `SELECT id, tenant_id, event_type, routing_key, event_version, aggregate_type,
              aggregate_id, process_id, payload, metadata, occurred_at, attempts
         FROM outbox_events
        WHERE status = 'PENDING'
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY occurred_at, id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  }

  /** Marca as linhas publicadas (só depois da confirmação do `addBulk`). */
  async markPublished(client: SqlClient, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await client.query(
      `UPDATE outbox_events
          SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1,
              next_attempt_at = NULL, last_error = NULL
        WHERE id = ANY($1::uuid[]) AND status = 'PENDING'`,
      [ids],
    );
    return rowCount ?? 0;
  }

  /** Linha inválida com tentativas restantes: backoff isolado (FA-03 · RN-FND-57). */
  async markRetry(
    client: SqlClient,
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void> {
    await client.query(
      `UPDATE outbox_events
          SET attempts = $2, next_attempt_at = $3, last_error = $4
        WHERE id = $1 AND status = 'PENDING'`,
      [id, attempts, nextAttemptAt, error.slice(0, LAST_ERROR_MAX)],
    );
  }

  /** Tentativas esgotadas: `FAILED` (republicação manual — US-083). */
  async markFailed(client: SqlClient, id: string, attempts: number, error: string): Promise<void> {
    await client.query(
      `UPDATE outbox_events
          SET status = 'FAILED', attempts = $2, next_attempt_at = NULL, last_error = $3
        WHERE id = $1 AND status = 'PENDING'`,
      [id, attempts, error.slice(0, LAST_ERROR_MAX)],
    );
  }

  /**
   * Purga (DEC-085 · RN-FND-59), papel `cf_maintenance`: um lote de `PUBLISHED` publicados antes
   * de `before`; nunca `PENDING`/`FAILED`. Sem trava: o relay nunca altera linha `PUBLISHED`.
   * Devolve quantas linhas apagou.
   */
  async purgePublishedBatch(client: SqlClient, before: Date, limit: number): Promise<number> {
    const { rowCount } = await client.query(
      `DELETE FROM outbox_events
        WHERE status = 'PUBLISHED'
          AND id IN (
          SELECT id FROM outbox_events
           WHERE status = 'PUBLISHED' AND published_at < $1
           ORDER BY published_at
           LIMIT $2)`,
      [before, limit],
    );
    return rowCount ?? 0;
  }
}
