import type { TenantTx } from '#shared/database/prisma.js';

import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';
import type { TimelineLookupKind, TimelineLookupRecords } from '../domain/timeline-lookups.js';

/*
 * Portas do módulo `timeline` (US-059): gravação em `process_timeline_entries` (Prisma, ou em
 * memória no modo de identidade fake) e as fontes dos nomes congelados.
 */

export type TimelineInsertOutcome = 'inserted' | 'duplicate';

export interface TimelineEntryStore {
  /**
   * `INSERT … ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING` no `tx` do caso de uso
   * (RN-TML-01/03). `duplicate` = a entrada já existia (reprocessamento do mesmo evento).
   */
  insert(tx: TenantTx, entry: ProcessTimelineEntry): Promise<TimelineInsertOutcome>;
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
