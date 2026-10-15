import type { AuditAction } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { CoalesceState } from '../domain/audit-coalescer.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';

/*
 * Portas da aplicação do módulo `audit` (US-073): Prisma em `infrastructure/`, em memória no modo
 * de identidade fake (local/dev/test) e nos testes.
 */

export interface CoalesceQuery {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorUserId: string;
  readonly scope: string | null;
  /** Início da janela (`agora − audit.coalesce.windowMinutes`). */
  readonly since: Date;
}

export interface AuditLogStore {
  /**
   * INSERT no `tx` recebido (nunca transação própria — RN-AUD-01), sem RETURNING.
   * @throws AuditPartitionMissingError quando não há partição para `occurredAt` (FA-03)
   */
  insert(tx: TenantTx, record: SealedAuditRecord): Promise<void>;
  /** Estado de coalescência do último registro gravado da chave dentro da janela. */
  findLastCoalesced(tx: TenantTx, query: CoalesceQuery): Promise<CoalesceState | null>;
}

export const AUDIT_LOG_STORE = Symbol('AuditLogStore');

/** Transações das gravações avulsas (`recordStandalone`): no tenant do contexto ou de plataforma. */
export interface AuditTransactions {
  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Sem `app.tenant_id`: só aceita registro com `tenantId` nulo (política `platform_insert`). */
  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const AUDIT_TRANSACTIONS = Symbol('AuditTransactions');

/** Partições mensais de `audit_logs` (DEC-085 · FA-03). */
export interface AuditPartitionsPort {
  /** Garante o mês corrente e os `monthsAhead` seguintes; devolve quantas partições criou. */
  ensure(monthsAhead: number): Promise<number>;
}

export const AUDIT_PARTITIONS = Symbol('AuditPartitionsPort');

/** Relógio injetável (janela de coalescência e testes). */
export type AuditClock = () => Date;

export const AUDIT_CLOCK = Symbol('AuditClock');

/** Não há partição de `audit_logs` para o mês do registro (FA-03): a transação é desfeita. */
export class AuditPartitionMissingError extends Error {
  constructor(
    readonly occurredAt: Date,
    options?: { cause?: unknown },
  ) {
    super(`audit_logs sem partição para ${occurredAt.toISOString().slice(0, 7)}.`, options);
    this.name = 'AuditPartitionMissingError';
  }
}
