import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type {
  AuditLogStore,
  AuditPartitionsPort,
  AuditSealListCriteria,
  AuditSealStore,
  AuditTransactions,
  CoalesceQuery,
  SessionRecordQuery,
} from '../application/ports.js';
import { coalesceStateFrom } from '../domain/audit-coalescer.js';
import type { CoalesceState } from '../domain/audit-coalescer.js';
import {
  compareAuditRecords,
  isAfterAuditCursor,
  matchesAuditCriteria,
} from '../domain/audit-log-query.js';
import type { AuditLogCriteria, AuditLogPageQuery } from '../domain/audit-log-query.js';
import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import { SEAL_PERIOD_MS } from '../domain/audit-seal.js';
import type { AuditSeal, SealPeriod } from '../domain/audit-seal.js';

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

  existsForSession(_tx: TenantTx, query: SessionRecordQuery): Promise<boolean> {
    return Promise.resolve(
      this.records.some(
        (record) =>
          record.tenantId === query.tenantId &&
          record.action === query.action &&
          record.sessionIdHash === query.sessionIdHash &&
          record.occurredAt.getTime() === query.occurredAt.getTime(),
      ),
    );
  }

  search(_tx: TenantTx, query: AuditLogPageQuery): Promise<SealedAuditRecord[]> {
    return Promise.resolve(
      this.records
        .filter((record) => matchesAuditCriteria(record, query))
        .filter((record) => isAfterAuditCursor(record, query.after))
        .sort(compareAuditRecords)
        .slice(0, query.take),
    );
  }

  findById(_tx: TenantTx, tenantId: string, id: string): Promise<SealedAuditRecord | null> {
    return Promise.resolve(
      this.records.find((record) => record.id === id && record.tenantId === tenantId) ?? null,
    );
  }

  count(_tx: TenantTx, criteria: AuditLogCriteria, cap: number): Promise<number> {
    let total = 0;
    for (const record of this.records) {
      if (matchesAuditCriteria(record, criteria)) total += 1;
      if (total >= cap) break;
    }
    return Promise.resolve(total);
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

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/** Sem banco não há partições a criar. */
export class InMemoryAuditPartitions implements AuditPartitionsPort {
  ensure(): Promise<number> {
    return Promise.resolve(0);
  }
}

/** Ordem da trilha: `(occurredAt, id)` — a mesma do `ORDER BY occurred_at, id` do PostgreSQL. */
function byTrailOrder(left: AuditRecord, right: AuditRecord): number {
  const time = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (time !== 0) return time;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Selos em memória (modo fake e testes — US-074): sem worker no modo fake, os selos entram por
 * `seed`; os registros dos períodos vêm da trilha em memória, com o mesmo isolamento por tenant.
 */
export class InMemoryAuditSealStore implements AuditSealStore {
  readonly seals: AuditSeal[] = [];

  constructor(private readonly logs: InMemoryAuditLogStore) {}

  seed(...seals: AuditSeal[]): void {
    this.seals.push(...seals);
  }

  private ofTenant(tenantId: string): AuditSeal[] {
    return this.seals
      .filter((seal) => seal.tenantId === tenantId)
      .sort((left, right) => left.periodStart.getTime() - right.periodStart.getTime());
  }

  list(
    _tx: TenantTx,
    criteria: AuditSealListCriteria,
  ): Promise<{ readonly items: readonly AuditSeal[]; readonly total: number }> {
    const matching = this.ofTenant(criteria.tenantId)
      .filter(
        (seal) =>
          (criteria.periodFrom === null || seal.periodStart >= criteria.periodFrom) &&
          (criteria.periodTo === null || seal.periodStart <= criteria.periodTo),
      )
      .reverse();
    return Promise.resolve({
      items: matching.slice(criteria.skip, criteria.skip + criteria.take),
      total: matching.length,
    });
  }

  findInRange(
    _tx: TenantTx,
    query: {
      readonly tenantId: string;
      readonly from: Date;
      readonly to: Date;
      readonly limit: number;
    },
  ): Promise<readonly AuditSeal[]> {
    return Promise.resolve(
      this.ofTenant(query.tenantId)
        .filter((seal) => seal.periodStart >= query.from && seal.periodStart <= query.to)
        .slice(0, query.limit),
    );
  }

  findPredecessor(_tx: TenantTx, tenantId: string, before: Date): Promise<AuditSeal | null> {
    return Promise.resolve(
      this.ofTenant(tenantId)
        .filter((seal) => seal.periodStart < before)
        .at(-1) ?? null,
    );
  }

  periodRecords(
    _tx: TenantTx,
    tenantId: string,
    period: SealPeriod,
  ): Promise<readonly AuditRecord[]> {
    const next = period.start.getTime() + SEAL_PERIOD_MS;
    return Promise.resolve(
      this.logs.records
        .filter(
          (record) =>
            record.tenantId === tenantId &&
            record.occurredAt.getTime() >= period.start.getTime() &&
            record.occurredAt.getTime() < next,
        )
        .sort(byTrailOrder),
    );
  }
}
