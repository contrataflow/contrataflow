import type { AuditAction, AuditCategory, AuditResult } from '@contrataflow/types';

import type { AuditRecord } from './audit-record.js';

/*
 * Leitura da trilha (US-075 · AUD-01/AUD-03): critérios resolvidos dos filtros (RN-AUD-17 — E entre
 * parâmetros, OU dentro do mesmo), a ordem fixa da paginação por cursor (`occurredAt DESC, id DESC`,
 * a direção dos índices de entities.md §4) e o predicado em memória. O SQL de
 * `PrismaAuditLogStore` os espelha; o período é sempre obrigatório (poda das partições mensais).
 */

/** Posição do cursor: o último registro devolvido (estritamente "depois" dele na ordem). */
export interface AuditCursorPosition {
  readonly occurredAt: Date;
  readonly id: string;
}

export interface AuditLogCriteria {
  readonly tenantId: string;
  /** Período inclusivo sobre `occurredAt` (obrigatório — RN-AUD-17). */
  readonly occurredFrom: Date;
  readonly occurredTo: Date;
  /** Cada lista é OU; `null` = sem filtro. */
  readonly actorUserIds: readonly string[] | null;
  readonly actions: readonly AuditAction[] | null;
  readonly categories: readonly AuditCategory[] | null;
  readonly results: readonly AuditResult[] | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly processId: string | null;
}

/** Uma página: critérios, cursor e `limit + 1` (o excedente indica `hasMore`). */
export interface AuditLogPageQuery extends AuditLogCriteria {
  readonly after: AuditCursorPosition | null;
  readonly take: number;
}

/** Filtros da query (já validados pelo schema de AUD-01/AUD-03). */
export interface AuditLogFilterInput {
  readonly occurredFrom: string;
  readonly occurredTo: string;
  readonly actorUserId?: readonly string[] | undefined;
  readonly action?: readonly AuditAction[] | undefined;
  readonly category?: readonly AuditCategory[] | undefined;
  readonly result?: readonly AuditResult[] | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly processId?: string | undefined;
}

const list = <T>(values: readonly T[] | undefined): readonly T[] | null =>
  values === undefined || values.length === 0 ? null : [...values];

/** Filtros da query → critérios da consulta, no tenant da sessão. */
export function auditCriteriaOf(tenantId: string, filters: AuditLogFilterInput): AuditLogCriteria {
  return {
    tenantId,
    occurredFrom: new Date(filters.occurredFrom),
    occurredTo: new Date(filters.occurredTo),
    actorUserIds: list(filters.actorUserId),
    actions: list(filters.action),
    categories: list(filters.category),
    results: list(filters.result),
    entityType: filters.entityType ?? null,
    entityId: filters.entityId ?? null,
    processId: filters.processId ?? null,
  };
}

/** Filtros opcionais aplicados (sem valores) — log `audit.search_executed`. */
const OPTIONAL_FILTERS = [
  'actorUserId',
  'action',
  'category',
  'result',
  'entityType',
  'entityId',
  'processId',
] as const;

export function auditFilterKeys(filters: AuditLogFilterInput): string[] {
  return OPTIONAL_FILTERS.filter((key) => filters[key] !== undefined);
}

/**
 * Filtros aplicados para o `metadata` de `audit.search`/`audit.export` (RN-AUD-23): quem consultou
 * o quê. São ids, códigos do catálogo e o período — nada do conteúdo dos registros.
 */
export function auditFiltersMetadata(
  filters: AuditLogFilterInput,
): Record<string, string | string[] | null> {
  return {
    occurredFrom: filters.occurredFrom,
    occurredTo: filters.occurredTo,
    actorUserId: filters.actorUserId ? [...filters.actorUserId] : null,
    action: filters.action ? [...filters.action] : null,
    category: filters.category ? [...filters.category] : null,
    result: filters.result ? [...filters.result] : null,
    entityType: filters.entityType ?? null,
    entityId: filters.entityId ?? null,
    processId: filters.processId ?? null,
  };
}

/** Ordem da consulta: mais recente primeiro; empate no instante desfeito pelo `id` decrescente. */
export function compareAuditRecords(
  left: Pick<AuditRecord, 'occurredAt' | 'id'>,
  right: Pick<AuditRecord, 'occurredAt' | 'id'>,
): number {
  const byTime = right.occurredAt.getTime() - left.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

/** O registro vem estritamente depois da posição do cursor na ordem da consulta. */
export function isAfterAuditCursor(
  record: Pick<AuditRecord, 'occurredAt' | 'id'>,
  position: AuditCursorPosition | null,
): boolean {
  return position === null || compareAuditRecords(position, record) < 0;
}

const within = <T>(values: readonly T[] | null, value: T | null): boolean =>
  values === null || (value !== null && values.includes(value));

/** Todos os critérios em memória (mesmo predicado do SQL). */
export function matchesAuditCriteria(record: AuditRecord, criteria: AuditLogCriteria): boolean {
  if (record.tenantId !== criteria.tenantId) return false;
  const time = record.occurredAt.getTime();
  if (time < criteria.occurredFrom.getTime() || time > criteria.occurredTo.getTime()) return false;
  if (!within(criteria.actorUserIds, record.actorUserId)) return false;
  if (!within(criteria.actions, record.action)) return false;
  if (!within(criteria.categories, record.category)) return false;
  if (!within(criteria.results, record.result)) return false;
  if (criteria.entityType !== null && record.entityType !== criteria.entityType) return false;
  if (criteria.entityId !== null && record.entityId !== criteria.entityId) return false;
  return criteria.processId === null || record.processId === criteria.processId;
}
