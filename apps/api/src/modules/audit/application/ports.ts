import type { AuditAction } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

import type { CoalesceState } from '../domain/audit-coalescer.js';
import type { AuditLogCriteria, AuditLogPageQuery } from '../domain/audit-log-query.js';
import type { AuditRecord, SealedAuditRecord } from '../domain/audit-record.js';
import type { AuditSeal, SealPeriod } from '../domain/audit-seal.js';

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

export interface SessionRecordQuery {
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly sessionIdHash: string;
  /** Horário exato do fato: escolhe a partição (poda) e o índice `(tenant, action, occurred_at)`. */
  readonly occurredAt: Date;
}

export interface AuditLogStore {
  /**
   * INSERT no `tx` recebido (nunca transação própria — RN-AUD-01), sem RETURNING.
   * @throws AuditPartitionMissingError quando não há partição para `occurredAt` (FA-03)
   */
  insert(tx: TenantTx, record: SealedAuditRecord): Promise<void>;
  /** Estado de coalescência do último registro gravado da chave dentro da janela. */
  findLastCoalesced(tx: TenantTx, query: CoalesceQuery): Promise<CoalesceState | null>;
  /** `oncePerSession`: já há registro desta ação, neste horário, para esta sessão no tenant? */
  existsForSession(tx: TenantTx, query: SessionRecordQuery): Promise<boolean>;
  /**
   * AUD-01/AUD-03 (US-075): uma página dos registros do tenant que atendem aos critérios, em
   * `occurredAt DESC, id DESC`, depois do cursor — no máximo `take`.
   */
  search(tx: TenantTx, query: AuditLogPageQuery): Promise<SealedAuditRecord[]>;
  /** AUD-02: o registro do tenant pelo id; o de outro tenant é `null` (como o inexistente). */
  findById(tx: TenantTx, tenantId: string, id: string): Promise<SealedAuditRecord | null>;
  /**
   * AUD-03 (RN-AUD-19): quantos registros atendem aos critérios, contando no máximo `cap` — a
   * contagem para no teto (`maxRows + 1` basta para recusar com `EXPORT_TOO_LARGE`).
   */
  count(tx: TenantTx, criteria: AuditLogCriteria, cap: number): Promise<number>;
}

export const AUDIT_LOG_STORE = Symbol('AuditLogStore');

/** Transações das gravações avulsas (`recordStandalone`): no tenant do contexto ou de plataforma. */
export interface AuditTransactions {
  inTenant<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Sem `app.tenant_id`: só aceita registro com `tenantId` nulo (política `platform_insert`). */
  inPlatform<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Leitura no tenant do contexto (transação somente leitura — AUD-01..05). */
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
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

/** Filtro de AUD-04: `periodStart` dentro de `[periodFrom, periodTo]` (extremos opcionais). */
export interface AuditSealListCriteria {
  readonly tenantId: string;
  readonly periodFrom: Date | null;
  readonly periodTo: Date | null;
  readonly skip: number;
  readonly take: number;
}

/**
 * Selos de `audit_seals` (US-074): gravados só pelo worker (`AuditSealer`); a API lista e
 * recalcula. Toda consulta filtra `tenant_id` explicitamente, além da RLS.
 */
export interface AuditSealStore {
  /** Mais recente primeiro (`period_start DESC`) e o total do filtro. */
  list(
    tx: TenantTx,
    criteria: AuditSealListCriteria,
  ): Promise<{ readonly items: readonly AuditSeal[]; readonly total: number }>;
  /** Selos com `periodStart` em `[from, to]`, em ordem de período — no máximo `limit`. */
  findInRange(
    tx: TenantTx,
    query: {
      readonly tenantId: string;
      readonly from: Date;
      readonly to: Date;
      readonly limit: number;
    },
  ): Promise<readonly AuditSeal[]>;
  /** O selo do tenant imediatamente anterior a `before` (antecessor real na cadeia). */
  findPredecessor(tx: TenantTx, tenantId: string, before: Date): Promise<AuditSeal | null>;
  /** Registros ATUAIS do período, por `(occurredAt, id)`, com os campos do `rowHash`. */
  periodRecords(
    tx: TenantTx,
    tenantId: string,
    period: SealPeriod,
  ): Promise<readonly AuditRecord[]>;
}

export const AUDIT_SEAL_STORE = Symbol('AuditSealStore');
