import { timelineTypesOfGroups } from '@contrataflow/types';
import type { TimelineEntryType, TimelineGroup } from '@contrataflow/types';

import type { ProcessTimelineEntry } from './timeline-entry.js';

/*
 * Leitura da timeline (US-060 · PRC-12): critérios resolvidos dos filtros (RN-TML-10..12), a regra
 * de visibilidade `BUDGET_RESTRICTED` (RN-TML-13) e a ordem fixa da paginação por cursor
 * (RN-TML-09 — `occurredAt DESC, id DESC`, a direção do índice de entities.md §4.10). As mesmas
 * funções valem para a consulta em memória; o SQL de `PrismaTimelineEntryStore.list` as espelha.
 */

/** Posição do cursor: a última entrada devolvida (estritamente "depois" dela na ordem). */
export interface TimelineCursorPosition {
  readonly occurredAt: Date;
  readonly id: string;
}

export interface TimelineFeedSearch {
  readonly processId: string;
  /** Tipos dos grupos pedidos (OU); `null` = todos os tipos. */
  readonly types: readonly TimelineEntryType[] | null;
  /** Atores pedidos (OU); `null` = todos. */
  readonly actorIds: readonly string[] | null;
  /** Período inclusivo sobre `occurredAt` (RN-TML-10). */
  readonly occurredFrom: Date | null;
  readonly occurredTo: Date | null;
  /** POL-09 (RN-TML-13): `false` exclui as entradas `BUDGET_RESTRICTED` na própria consulta. */
  readonly includeRestricted: boolean;
  readonly after: TimelineCursorPosition | null;
  /** `limit + 1` (o excedente indica `hasMore`). */
  readonly take: number;
}

/** Filtros da query (já validados pelo schema de PRC-12). */
export interface TimelineFilters {
  readonly group?: readonly TimelineGroup[] | undefined;
  readonly actorId?: readonly string[] | undefined;
  readonly occurredFrom?: string | undefined;
  readonly occurredTo?: string | undefined;
}

/** Filtros da query → critérios da consulta (grupos traduzidos em tipos — RN-TML-12). */
export function timelineCriteriaOf(
  filters: TimelineFilters,
): Pick<TimelineFeedSearch, 'types' | 'actorIds' | 'occurredFrom' | 'occurredTo'> {
  return {
    types: filters.group === undefined ? null : timelineTypesOfGroups(filters.group),
    actorIds: filters.actorId === undefined ? null : [...filters.actorId],
    occurredFrom: filters.occurredFrom === undefined ? null : new Date(filters.occurredFrom),
    occurredTo: filters.occurredTo === undefined ? null : new Date(filters.occurredTo),
  };
}

/** Chaves dos filtros usados (sem valores) — log `timeline.listed` e cardinalidade da métrica. */
export function timelineFilterKeys(filters: TimelineFilters): string[] {
  return (['group', 'actorId', 'occurredFrom', 'occurredTo'] as const).filter(
    (key) => filters[key] !== undefined,
  );
}

/** RN-TML-13: entrada `BUDGET_RESTRICTED` só com POL-09; as `STANDARD`, para quem vê o processo. */
export function isEntryVisible(
  entry: Pick<ProcessTimelineEntry, 'visibility'>,
  includeRestricted: boolean,
): boolean {
  return entry.visibility === 'STANDARD' || includeRestricted;
}

/** Ordem da timeline: mais recente primeiro; empate no instante desfeito pelo `id` decrescente. */
export function compareTimelineEntries(
  left: Pick<ProcessTimelineEntry, 'occurredAt' | 'id'>,
  right: Pick<ProcessTimelineEntry, 'occurredAt' | 'id'>,
): number {
  const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

/** A entrada vem estritamente depois da posição do cursor na ordem da timeline. */
export function isAfterCursor(
  entry: Pick<ProcessTimelineEntry, 'occurredAt' | 'id'>,
  position: TimelineCursorPosition | null,
): boolean {
  return position === null || compareTimelineEntries(position, entry) < 0;
}

/** Todos os critérios em memória (mesmo predicado do SQL). */
export function matchesTimelineSearch(
  entry: ProcessTimelineEntry,
  search: TimelineFeedSearch,
): boolean {
  if (entry.processId !== search.processId) return false;
  if (!isEntryVisible(entry, search.includeRestricted)) return false;
  if (search.types !== null && !search.types.includes(entry.type)) return false;
  if (
    search.actorIds !== null &&
    (entry.actorId === null || !search.actorIds.includes(entry.actorId))
  ) {
    return false;
  }
  const time = entry.occurredAt.getTime();
  if (search.occurredFrom !== null && time < search.occurredFrom.getTime()) return false;
  if (search.occurredTo !== null && time > search.occurredTo.getTime()) return false;
  return isAfterCursor(entry, search.after);
}
