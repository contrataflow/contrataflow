import type { TenantTx } from '#shared/database/prisma.js';

import type { OutboxRow, OutboxStore } from '../../application/outbox-ports.js';

/** Linha guardada em memória, com o instante de gravação. */
export interface InMemoryOutboxRow extends OutboxRow {
  readonly occurredAt: Date;
}

/**
 * Outbox em memória (modo de identidade fake — local/dev/test sem banco — e testes). Sem relay:
 * as linhas só servem para inspeção (`rows`).
 */
export class InMemoryOutboxStore implements OutboxStore {
  readonly rows: InMemoryOutboxRow[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  insert(_tx: TenantTx, row: OutboxRow): Promise<Date> {
    const occurredAt = this.now();
    this.rows.push({ ...row, occurredAt });
    return Promise.resolve(occurredAt);
  }

  insertOnce(tx: TenantTx, row: OutboxRow): Promise<Date | null> {
    if (this.rows.some((stored) => stored.id === row.id)) return Promise.resolve(null);
    return this.insert(tx, row);
  }
}
