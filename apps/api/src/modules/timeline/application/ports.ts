import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';
import type { TimelineFeedSearch } from '../domain/timeline-feed.js';
import type { TimelineLookupKind, TimelineLookupRecords } from '../domain/timeline-lookups.js';

/*
 * Portas do módulo `timeline` (US-059): gravação em `process_timeline_entries` (Prisma, ou em
 * memória no modo de identidade fake) e as fontes dos nomes congelados. US-060: a leitura
 * paginada da timeline (PRC-12) e as transações de leitura do módulo.
 */

export type TimelineInsertOutcome = 'inserted' | 'duplicate';

export interface TimelineEntryStore {
  /**
   * `INSERT … ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING` no `tx` do caso de uso
   * (RN-TML-01/03). `duplicate` = a entrada já existia (reprocessamento do mesmo evento).
   */
  insert(tx: TenantTx, entry: ProcessTimelineEntry): Promise<TimelineInsertOutcome>;
  /**
   * PRC-12 (US-060): entradas do processo que casam os filtros, `occurredAt DESC, id DESC`, a
   * partir do cursor, até `take` (RN-TML-09..13). `BUDGET_RESTRICTED` sai no próprio filtro da
   * consulta quando `includeRestricted = false` — nunca depois de paginar.
   */
  list(tx: TenantTx, search: TimelineFeedSearch): Promise<ProcessTimelineEntry[]>;
}

export const TIMELINE_ENTRY_STORE = Symbol('TimelineEntryStore');

/**
 * Fonte de um tipo de referência (RN-TML-04): lê, em lote e no `tx` do caso de uso (RLS do
 * tenant), os registros pela fachada do módulo dono. ID ausente do resultado = não encontrado.
 */
export interface TimelineLookupSource<K extends TimelineLookupKind> {
  readonly kind: K;
  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords[K]>>;
}

export type AnyTimelineLookupSource = {
  [K in TimelineLookupKind]: TimelineLookupSource<K>;
}[TimelineLookupKind];

/**
 * Fontes registradas no `TimelineModule` (uma por tipo). Cada story que passa a publicar um evento
 * mapeado acrescenta aqui a fonte das referências dele — sem a fonte, a projeção falha (V-01).
 */
export const TIMELINE_LOOKUP_SOURCES = Symbol('TimelineLookupSources');

/** Transações de leitura do módulo (`app.tenant_id` para a RLS — US-060). */
export interface TimelineTransactions {
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const TIMELINE_TRANSACTIONS = Symbol('TimelineTransactions');
