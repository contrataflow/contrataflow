import type { TaskInboxSort, TaskInboxView } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { InboxItemRow, InboxViewer } from '../domain/task-inbox.js';

/*
 * Portas do módulo `inbox` (US-056): a leitura das views publicadas (`InboxReader` — SQL sobre
 * PostgreSQL ou memória no modo fake), a transação de leitura e o relógio.
 */

export interface InboxPageSearch {
  readonly view: TaskInboxView;
  readonly sort: TaskInboxSort;
  readonly page: number;
  readonly pageSize: number;
  readonly viewer: InboxViewer;
  readonly now: Date;
}

export interface InboxPage {
  readonly rows: InboxItemRow[];
  readonly totalItems: number;
}

/** Contagem por visão (RN-INBOX-09); `UNIT_QUEUE` é contado mesmo quando a aba não se aplica. */
export type InboxCounts = Readonly<Record<TaskInboxView, number>>;

export interface InboxReader {
  /** Página e total da visão numa única leitura (mesmo snapshot — RN-INBOX-09). */
  page(tx: TenantTx, search: InboxPageSearch): Promise<InboxPage>;
  /** Contadores de todas as visões numa única leitura, com os predicados de `page`. */
  counts(tx: TenantTx, viewer: InboxViewer, now: Date): Promise<InboxCounts>;
}

export interface InboxTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export type InboxClock = () => Date;

export const INBOX_READER = Symbol('InboxReader');
export const INBOX_TRANSACTIONS = Symbol('InboxTransactions');
export const INBOX_CLOCK = Symbol('InboxClock');
