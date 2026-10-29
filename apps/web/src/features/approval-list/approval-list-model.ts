import {
  APPROVAL_LIST_DEFAULT_PAGE_SIZE,
  APPROVAL_LIST_DEFAULT_STATUSES,
  APPROVAL_LIST_QUERY_LIMITS,
  APPROVAL_LIST_SORT_FIELDS,
  formatApprovalListSort,
  isApprovalPeriodValid,
  parseApprovalListSort,
} from '@contrataflow/validation';
import type {
  ApprovalListSort,
  ApprovalStatus,
  ApprovalSubjectType,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela da lista de aprovações (US-057 · SCR-014), puras: filtros ↔ query de APV-01
 * (RN-INBOX-15 — V-02 barra a chamada com o período invertido, V-03 ignora a busca curta), a
 * ordenação (RN-INBOX-18), o estado vazio certo (FA-01 × FA-05) e o que a UI faz em cada falha.
 */

export interface ApprovalFilters {
  readonly statuses: readonly ApprovalStatus[];
  readonly subjectType: ApprovalSubjectType | '';
  readonly requestingDepartmentId: string;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly q: string;
}

export const DEFAULT_FILTERS: ApprovalFilters = {
  statuses: APPROVAL_LIST_DEFAULT_STATUSES,
  subjectType: '',
  requestingDepartmentId: '',
  requestedFrom: '',
  requestedTo: '',
  q: '',
};

export const DEFAULT_SORT: ApprovalListSort = { field: 'requestedAt', direction: 'desc' };

/** V-02: o período invertido nunca vai para a API. */
export function isPeriodValid(filters: ApprovalFilters): boolean {
  return isApprovalPeriodValid(filters.requestedFrom, filters.requestedTo);
}

/** V-03: a busca com menos de 2 caracteres é ignorada. */
export function effectiveSearch(q: string): string | undefined {
  const trimmed = q.trim();
  return trimmed.length >= APPROVAL_LIST_QUERY_LIMITS.qMin ? trimmed : undefined;
}

const sameStatuses = (a: readonly ApprovalStatus[], b: readonly ApprovalStatus[]) =>
  a.length === b.length && a.every((status) => b.includes(status));

/** Algum filtro além do padrão (FA-05 mostra "Limpar filtros"; FA-01 é só com o padrão). */
export function hasActiveFilters(filters: ApprovalFilters): boolean {
  return (
    !sameStatuses(filters.statuses, DEFAULT_FILTERS.statuses) ||
    filters.subjectType !== '' ||
    filters.requestingDepartmentId !== '' ||
    filters.requestedFrom !== '' ||
    filters.requestedTo !== '' ||
    effectiveSearch(filters.q) !== undefined
  );
}

/** Situação de cada aba (prd-5): a aba é o filtro de status de APV-01, um status por vez. */
export function statusTabOf(filters: ApprovalFilters): ApprovalStatus {
  return filters.statuses[0] ?? 'PENDING';
}

/** Filtros do popover e busca, além da aba (o vazio "você está em dia" só vale sem eles). */
export function activeRefinements(
  filters: ApprovalFilters,
): ('subjectType' | 'requestingDepartmentId' | 'period' | 'q')[] {
  return [
    ...(filters.subjectType === '' ? [] : (['subjectType'] as const)),
    ...(filters.requestingDepartmentId === '' ? [] : (['requestingDepartmentId'] as const)),
    ...(filters.requestedFrom === '' && filters.requestedTo === '' ? [] : (['period'] as const)),
    ...(effectiveSearch(filters.q) === undefined ? [] : (['q'] as const)),
  ];
}

/** Contador da aba: o total de APV-01 com os demais filtros (`pageSize=1`; sem contrato novo). */
export function tabCountQuery(
  filters: ApprovalFilters,
  status: ApprovalStatus,
): Record<string, string | number | undefined> {
  return {
    ...approvalListQuery({ ...filters, statuses: [status] }, DEFAULT_SORT, 1),
    pageSize: 1,
  };
}

/** Query string de APV-01 (os vazios ficam de fora). */
export function approvalListQuery(
  filters: ApprovalFilters,
  sort: ApprovalListSort,
  page: number,
): Record<string, string | number | undefined> {
  const orEmpty = (value: string) => (value === '' ? undefined : value);
  return {
    status: filters.statuses.length === 0 ? undefined : filters.statuses.join(','),
    subjectType: orEmpty(filters.subjectType),
    requestingDepartmentId: orEmpty(filters.requestingDepartmentId),
    requestedFrom: orEmpty(filters.requestedFrom),
    requestedTo: orEmpty(filters.requestedTo),
    q: effectiveSearch(filters.q),
    sort: formatApprovalListSort(sort),
    page,
    pageSize: APPROVAL_LIST_DEFAULT_PAGE_SIZE,
  };
}

/** Opções do seletor de ordenação (texto do parâmetro `sort`). */
export function sortOptions(): string[] {
  return APPROVAL_LIST_SORT_FIELDS.flatMap((field) => [
    formatApprovalListSort({ field, direction: field === 'code' ? 'asc' : 'desc' }),
    formatApprovalListSort({ field, direction: field === 'code' ? 'desc' : 'asc' }),
  ]);
}

export function parseSortOption(value: string): ApprovalListSort {
  return parseApprovalListSort(value) ?? DEFAULT_SORT;
}

export type ApprovalListProblem =
  | { readonly kind: 'invalidDepartment' }
  | { readonly kind: 'invalidFilter' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** Tabela "Casos de erro" da US-057. */
export function describeLoadError(error: unknown): ApprovalListProblem {
  if (!isApiError(error)) return { kind: 'unavailable' };
  if (error.status === 422) {
    return error.errors.some((issue) => issue.field === 'requestingDepartmentId')
      ? { kind: 'invalidDepartment' }
      : { kind: 'invalidFilter' };
  }
  if (error.status === 429) return { kind: 'rateLimited' };
  if (error.status >= 500 && error.status !== 503) {
    return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
  }
  return { kind: 'unavailable' };
}
