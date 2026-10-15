import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  AuditLogStore,
  AuditPartitionsPort,
  AuditTransactions,
  CoalesceQuery,
} from '../application/ports.js';
import { coalesceStateFrom } from '../domain/audit-coalescer.js';
import type { CoalesceState } from '../domain/audit-coalescer.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';

/** Registros mantidos em memória (o modo fake pode rodar por horas no dev local). */
const MAX_RECORDS = 10_000;

/**
 * Trilha em memória para o modo de identidade fake (local/dev/test, sem banco) e os testes: mesma
 * semântica do Prisma, inclusive o isolamento por tenant da consulta de coalescência.
 */
export class InMemoryAuditLogStore implements AuditLogStore {
  readonly records: SealedAuditRecord[] = [];

  insert(_tx: TenantTx, record: SealedAuditRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    return Promise.resolve();
  }

  findLastCoalesced(_tx: TenantTx, query: CoalesceQuery): Promise<CoalesceState | null> {
    const last = this.records
      .filter(
        (record) =>
          record.tenantId === query.tenantId &&
          record.entityType === query.entityType &&
          record.entityId === query.entityId &&
          record.action === query.action &&
          record.actorUserId === query.actorUserId &&
          record.occurredAt.getTime() >= query.since.getTime() &&
          ((record.metadata.coalesce as { scope?: unknown } | undefined)?.scope ?? null) ===
            query.scope,
      )
      .at(-1);
    return Promise.resolve(coalesceStateFrom(last?.metadata.coalesce ?? null));
  }
}

/** "Transações" do modo em memória: `tx` sentinela, ativo só durante o trabalho (V-03). */
export class InMemoryAuditTransactions implements AuditTransactions {
  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }

  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/** Sem banco não há partições a criar. */
export class InMemoryAuditPartitions implements AuditPartitionsPort {
  ensure(): Promise<number> {
    return Promise.resolve(0);
  }
}
