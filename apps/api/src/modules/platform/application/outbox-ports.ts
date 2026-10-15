import type { EventActor } from '@contrataflow/types';

import type { TenantTx } from '#shared/database/prisma.js';

/*
 * Portas do outbox no módulo `platform` (US-082): Prisma em `infrastructure/outbox`, em memória no
 * modo de identidade fake (local/dev/test sem banco) e nos testes.
 */

/** Linha a gravar em `outbox_events` (entities.md `OutboxEvent`); `occurred_at` vem do banco. */
export interface OutboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly routingKey: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly processId: string | null;
  readonly payload: Record<string, unknown>;
  /** Metadados técnicos (queues.md §5.1): ator, correlação, causa e trace. */
  readonly metadata: OutboxMetadata;
}

export interface OutboxMetadata {
  readonly actor: EventActor;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface OutboxStore {
  /**
   * INSERT `PENDING` no `tx` recebido, com `occurred_at = clock_timestamp()` (instante após o lock
   * do agregado — queues.md §5.4), e `pg_notify('cf_outbox')`. Devolve o `occurred_at` gravado.
   */
  insert(tx: TenantTx, row: OutboxRow): Promise<Date>;
}

export const OUTBOX_STORE = Symbol('OutboxStore');

/** Contrato do outbox violado: erro de programação, recusado antes do INSERT (RN-FND-50). */
export class OutboxContractError extends Error {
  constructor(
    readonly rule: 'V-01' | 'V-02' | 'TRANSACTION' | 'CONTEXT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${rule}: ${message}`, options);
    this.name = 'OutboxContractError';
  }
}
