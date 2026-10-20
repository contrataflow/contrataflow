import {
  IN_PROGRESS_STATUSES,
  PROCESS_LIST_DEFAULT_SORT,
  PROCESS_LIST_PARAM_KEYS,
  PROCESS_LIST_QUERY_LIMITS,
  parseProcessListParams,
} from '@contrataflow/validation';
import type { ProcessListParamKey, ProcessListSortField } from '@contrataflow/validation';

/*
 * Estado da consulta de SCR-004 (US-002): a URL é a fonte da verdade (link compartilhável — FA-03).
 * Funções puras sobre os parâmetros crus da URL: validação com o MESMO schema da API
 * (`parseProcessListParams`), padrão da tela sem parâmetros (RN-PROC-30), atalhos (RN-PROC-24),
 * chips, ordenação pelo cabeçalho e a query enviada ao PRC-01.
 */

export type ListParams = Readonly<Partial<Record<ProcessListParamKey, string>>>;

/** Parâmetros que não são filtros (não viram chip nem contam como "filtro ativo"). */
const TECHNICAL: ReadonlySet<ProcessListParamKey> = new Set([
  'page',
  'pageSize',
  'sort',
  'includeStageOptions',
]);

export interface ResolvedListState {
  readonly params: ListParams;
  /** Algum parâmetro conhecido da URL era inválido (aviso FA-03). */
  readonly hadInvalid: boolean;
  /** A URL não tinha parâmetros: o padrão da tela foi aplicado (RN-PROC-30). */
  readonly usedDefaults: boolean;
}

/** RN-PROC-30: sem parâmetros, status "Em andamento" (chip removível) e `-updatedAt`. */
export const DEFAULT_LIST_PARAMS: ListParams = { status: IN_PROGRESS_STATUSES.join(',') };

/** URL → estado validado (inválidos descartados; sem parâmetros = padrão da tela). */
export function resolveListState(search: URLSearchParams): ResolvedListState {
  const raw: Record<string, string> = {};
  let known = 0;
  for (const key of PROCESS_LIST_PARAM_KEYS) {
    const values = search.getAll(key);
    if (values.length > 0) {
      raw[key] = values.join(',');
      known += 1;
    }
  }
  if (known === 0) return { params: DEFAULT_LIST_PARAMS, hadInvalid: false, usedDefaults: true };
  const parsed = parseProcessListParams(raw);
  return { params: parsed.params, hadInvalid: parsed.invalid.length > 0, usedDefaults: false };
}

/**
 * Estado → query string da URL (ordem estável). Sem filtros o `status=` vazio não aparece; a
 * remoção de todos os filtros mantém `page=1` para não voltar ao padrão da tela.
 */
export function toSearchString(params: ListParams): string {
  const search = new URLSearchParams();
  // Filtros primeiro, depois ordenação e paginação (`status=…&sort=-priority`).
  const order: ProcessListParamKey[] = [
    ...PROCESS_LIST_PARAM_KEYS.filter((key) => !TECHNICAL.has(key)),
    'sort',
    'page',
    'pageSize',
  ];
  for (const key of order) {
    const value = params[key];
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? 'page=1' : text;
}

/** Query do PRC-01 (`includeStageOptions` só na primeira consulta — lacuna 1). */
export function toApiQuery(
  params: ListParams,
  options: { readonly includeStageOptions?: boolean } = {},
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of PROCESS_LIST_PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== '' && key !== 'includeStageOptions') query[key] = value;
  }
  if (options.includeStageOptions) query.includeStageOptions = 'true';
  return query;
}

/** Muda um filtro e volta à página 1 (fluxo principal, passo 8). */
export function withParam(
  params: ListParams,
  key: ProcessListParamKey,
  value: string | undefined,
): ListParams {
  const next: Partial<Record<ProcessListParamKey, string>> = Object.fromEntries(
    Object.entries(params).filter(([name]) => name !== key && (key === 'page' || name !== 'page')),
  );
  if (value !== undefined && value !== '') next[key] = value;
  return next;
}

export const valuesOf = (value: string | undefined): string[] =>
  value === undefined || value === '' ? [] : value.split(',').filter((part) => part !== '');

/** Atalhos (RN-PROC-24): predefinições combináveis entre si e com os demais filtros. */
export const QUICK_FILTERS = {
  mine: { key: 'currentResponsibleId', value: 'me' },
  myUnit: { key: 'currentDepartmentId', value: 'mine' },
  overdue: { key: 'overdue', value: 'true' },
  returned: { key: 'status', value: 'RETURNED' },
} as const satisfies Record<string, { key: ProcessListParamKey; value: string }>;

export type QuickFilter = keyof typeof QUICK_FILTERS;

export function isQuickFilterActive(params: ListParams, filter: QuickFilter): boolean {
  const { key, value } = QUICK_FILTERS[filter];
  return params[key] === value;
}

/** Ativar substitui o valor do filtro correspondente; desativar remove esse filtro. */
export function toggleQuickFilter(params: ListParams, filter: QuickFilter): ListParams {
  const { key, value } = QUICK_FILTERS[filter];
  return withParam(params, key, isQuickFilterActive(params, filter) ? undefined : value);
}

/** Filtros ativos (sem os técnicos), na ordem da tabela "Campos". */
export function activeFilterKeys(params: ListParams): ProcessListParamKey[] {
  return PROCESS_LIST_PARAM_KEYS.filter(
    (key) => !TECHNICAL.has(key) && params[key] !== undefined && params[key] !== '',
  );
}

/** "Limpar filtros": mantém ordenação e tamanho de página. */
export function clearFilters(params: ListParams): ListParams {
  const next: Partial<Record<ProcessListParamKey, string>> = {};
  if (params.sort !== undefined) next.sort = params.sort;
  if (params.pageSize !== undefined) next.pageSize = params.pageSize;
  return next;
}

export interface SortState {
  readonly field: ProcessListSortField;
  readonly direction: 'asc' | 'desc';
}

/** Ordenação principal efetiva (padrão `-updatedAt`; com busca e sem `sort`, relevância = null). */
export function primarySort(params: ListParams): SortState | null {
  const sort = params.sort ?? (params.q ? undefined : PROCESS_LIST_DEFAULT_SORT);
  if (sort === undefined) return null;
  const [first = ''] = sort.split(',');
  return first.startsWith('-')
    ? { field: first.slice(1) as ProcessListSortField, direction: 'desc' }
    : { field: first as ProcessListSortField, direction: 'asc' };
}

/** Clique no cabeçalho: mesmo campo alterna a direção; outro campo começa crescente. */
export function toggleSort(params: ListParams, field: ProcessListSortField): ListParams {
  const current = primarySort(params);
  const direction = current?.field === field && current.direction === 'asc' ? 'desc' : 'asc';
  return withParam(params, 'sort', `${direction === 'desc' ? '-' : ''}${field}`);
}

/** V-03: a busca só é enviada com 2 a 200 caracteres (após trim); vazia remove o filtro. */
export function searchValue(text: string): {
  readonly value: string | undefined;
  readonly tooShort: boolean;
} {
  const trimmed = text.trim();
  if (trimmed === '') return { value: undefined, tooShort: false };
  if (trimmed.length < PROCESS_LIST_QUERY_LIMITS.qMin) return { value: undefined, tooShort: true };
  return { value: trimmed.slice(0, PROCESS_LIST_QUERY_LIMITS.qMax), tooShort: false };
}

export const hasValueFilter = (params: ListParams) =>
  params.estimatedValueMin !== undefined || params.estimatedValueMax !== undefined;
