import type { OutboxDatabase } from '#shared/database/outbox-database.js';

import { OutboxRepository } from './outbox.repository.js';

export interface OutboxPurgeOptions {
  /** Retenção dos eventos publicados (DEC-085: 7 dias). */
  readonly retentionDays?: number;
  /** Linhas por lote/transação (queues.md §4.8: 5.000). */
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly repository?: OutboxRepository;
}

/**
 * Purga dos eventos `PUBLISHED` há mais de 7 dias (RN-FND-59 · DEC-085), em lotes de transações
 * curtas com o papel `cf_maintenance`; `PENDING` e `FAILED` nunca são tocados. Idempotente:
 * reexecutar só apaga o que ainda estiver vencido. O agendamento diário (fila `maintenance`,
 * job `outbox-purge`) é da US-083. Devolve o total apagado.
 */
export async function purgePublishedOutboxEvents(
  database: OutboxDatabase,
  options: OutboxPurgeOptions = {},
): Promise<number> {
  const repository = options.repository ?? new OutboxRepository();
  const batchSize = options.batchSize ?? 5_000;
  const now = (options.now ?? (() => new Date()))();
  const before = new Date(now.getTime() - (options.retentionDays ?? 7) * 24 * 3_600_000);
  let total = 0;
  for (;;) {
    const deleted = await database.transaction((client) =>
      repository.purgePublishedBatch(client, before, batchSize),
    );
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
