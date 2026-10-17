import {
  PROCESS_COLUMN_KEYS,
  PROCESS_EXPORT_MAX_ROWS,
  PROCESS_EXPORT_MESSAGES,
  PROCESS_FIXED_COLUMNS,
  SAVED_VIEW_MESSAGES,
  SAVED_VIEW_NAME_MAX,
  paramsFromSavedViewFilters,
  savedViewFiltersFromParams,
} from '@contrataflow/validation';
import type {
  ProcessColumnKey,
  ProcessListParamKey,
  SavedViewDto,
  SavedViewFilters,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { activeFilterKeys } from './process-list-state';
import type { ListParams } from './process-list-state';

/*
 * Modelo puro das visões salvas e da exportação CSV de SCR-004 (US-003): converte visão ⇄ estado da
 * lista (URL + colunas), detecta "Alterações não salvas", resume os critérios em texto, descarta
 * filtros que apontam para itens que não existem mais (FA-05 · RN-PROC-39), monta a query de PRC-34
 * e classifica os erros de PRC-34..38 para a tela. Sem React nem rede.
 */

// --- Colunas -------------------------------------------------------------------------------

/** Na tela a coluna é `responsible`; na API e na visão, `currentResponsible`. */
const RESPONSIBLE_ID = 'responsible';
const RESPONSIBLE_KEY: ProcessColumnKey = 'currentResponsible';

const isColumnKey = (value: string): value is ProcessColumnKey =>
  (PROCESS_COLUMN_KEYS as readonly string[]).includes(value);

/** Chave da API/visão → id de coluna da tela (`null` = a tela não tem a coluna, ex.: `tags`). */
export function columnIdOf(key: ProcessColumnKey): string | null {
  if (key === 'tags') return null;
  return key === RESPONSIBLE_KEY ? RESPONSIBLE_ID : key;
}

/** Id de coluna da tela → chave da API/visão (`null` = id desconhecido). */
export function columnKeyOf(id: string): ProcessColumnKey | null {
  const key = id === RESPONSIBLE_ID ? RESPONSIBLE_KEY : id;
  return isColumnKey(key) ? key : null;
}

/** Colunas de uma visão → ids da tela (ignora o que a tela não tem), sem repetição. */
export function columnIdsFromView(columns: readonly ProcessColumnKey[]): string[] {
  const ids: string[] = [];
  for (const key of columns) {
    const id = columnIdOf(key);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Colunas visíveis (ids da tela, na ordem da tela) → chaves de salvamento e de exportação. `code` e
 * `title` estão sempre presentes (V-04) — entram na frente se faltarem.
 */
export function columnKeysFromVisible(visibleIds: readonly string[]): ProcessColumnKey[] {
  const keys: ProcessColumnKey[] = [];
  for (const id of visibleIds) {
    const key = columnKeyOf(id);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  const missing = PROCESS_FIXED_COLUMNS.filter((fixed) => !keys.includes(fixed));
  return [...missing, ...keys];
}

// --- Filtros desatualizados (FA-05 · RN-PROC-39) -------------------------------------------

/**
 * Ids que existem hoje, por tipo de opção carregada. Ausente (`undefined`) = não foi possível
 * confirmar (opções ainda não carregadas, falha, ou lista truncada pelo limite da consulta): nesse
 * caso o filtro correspondente NUNCA é descartado. Itens inativos fazem parte das opções.
 */
export interface FilterAvailability {
  readonly units?: ReadonlySet<string> | undefined;
  readonly organizations?: ReadonlySet<string> | undefined;
  readonly contractingTypes?: ReadonlySet<string> | undefined;
  readonly modalities?: ReadonlySet<string> | undefined;
  readonly origins?: ReadonlySet<string> | undefined;
}

type AvailabilitySource = keyof FilterAvailability;

/** Filtro de visão → de onde vêm os ids válidos e quais valores reservados sempre valem. */
const AVAILABILITY_SOURCES: Readonly<
  Partial<
    Record<
      ProcessListParamKey,
      { readonly source: AvailabilitySource; readonly reserved?: readonly string[] }
    >
  >
> = {
  currentDepartmentId: { source: 'units', reserved: ['mine'] },
  requestingSecretariatId: { source: 'units' },
  requestingDepartmentId: { source: 'units' },
  organizationId: { source: 'organizations' },
  contractingTypeId: { source: 'contractingTypes' },
  modalityId: { source: 'modalities', reserved: ['none'] },
  originId: { source: 'origins' },
};

/** DEP-02 devolve até 50 unidades; CAT-01/ORG-01 são lidos com 100 por página. */
export const UNIT_LOOKUP_LIMIT = 50;
export const OPTION_PAGE_LIMIT = 100;

interface IdOption {
  readonly id: string;
}

/**
 * Opções carregadas → disponibilidade. Lista ausente ou com tantos itens quanto o limite da leitura
 * (pode estar truncada) vira `undefined`: sem certeza, não se descarta nada.
 */
export function buildAvailability(options: {
  readonly units?: readonly IdOption[] | undefined;
  readonly organizations?: readonly IdOption[] | undefined;
  readonly contractingTypes?: readonly IdOption[] | undefined;
  readonly modalities?: readonly IdOption[] | undefined;
  readonly origins?: readonly IdOption[] | undefined;
}): FilterAvailability {
  const ids = (list: readonly IdOption[] | undefined, limit: number) =>
    list === undefined || list.length >= limit
      ? undefined
      : new Set(list.map((option) => option.id));
  return {
    units: ids(options.units, UNIT_LOOKUP_LIMIT),
    organizations: ids(options.organizations, OPTION_PAGE_LIMIT),
    contractingTypes: ids(options.contractingTypes, OPTION_PAGE_LIMIT),
    modalities: ids(options.modalities, OPTION_PAGE_LIMIT),
    origins: ids(options.origins, OPTION_PAGE_LIMIT),
  };
}

export interface PrunedFilters {
  readonly filters: SavedViewFilters;
  /** Algum valor foi descartado (mostra o aviso de FA-05). */
  readonly dropped: boolean;
}

/** Remove dos `filters` os valores que não existem mais; a visão salva não é alterada. */
export function pruneStaleFilters(
  filters: SavedViewFilters,
  availability: FilterAvailability,
): PrunedFilters {
  const next: Record<string, unknown> = {};
  let dropped = false;
  for (const [key, values] of Object.entries(filters)) {
    const rule = AVAILABILITY_SOURCES[key as ProcessListParamKey];
    const known = rule === undefined ? undefined : availability[rule.source];
    if (rule === undefined || known === undefined || !Array.isArray(values)) {
      next[key] = values;
      continue;
    }
    const kept = (values as string[]).filter(
      (value) => known.has(value) || rule.reserved?.includes(value) === true,
    );
    if (kept.length !== values.length) dropped = true;
    if (kept.length > 0) next[key] = kept;
  }
  return { filters: next as SavedViewFilters, dropped };
}

// --- Aplicar e salvar ----------------------------------------------------------------------

export interface AppliedView {
  readonly params: ListParams;
  /** Ids de coluna da tela, como a visão guardou. */
  readonly columnIds: string[];
  /** Filtros descartados por não existirem mais (FA-05). */
  readonly dropped: boolean;
}

/** Aplicar = escrever filtros e ordenação nos parâmetros da URL e as colunas no estado. */
export function applyView(
  view: Pick<SavedViewDto, 'filters' | 'sort' | 'columns'>,
  availability: FilterAvailability,
): AppliedView {
  const pruned = pruneStaleFilters(view.filters, availability);
  const params: Partial<Record<ProcessListParamKey, string>> = {
    ...paramsFromSavedViewFilters(pruned.filters),
  };
  if (view.sort !== null && view.sort.trim() !== '') params.sort = view.sort;
  return { params, columnIds: columnIdsFromView(view.columns), dropped: pruned.dropped };
}

export interface ViewDefinition {
  readonly filters: SavedViewFilters;
  readonly sort: string | null;
  readonly columns: ProcessColumnKey[];
}

/** Estado atual da lista → critérios de uma visão (sem paginação). */
export function currentDefinition(
  params: ListParams,
  visibleColumnIds: readonly string[],
): ViewDefinition {
  const sort = params.sort?.trim() ?? '';
  return {
    filters: savedViewFiltersFromParams(params),
    sort: sort === '' ? null : sort,
    columns: columnKeysFromVisible(visibleColumnIds),
  };
}

// --- Alterações não salvas -----------------------------------------------------------------

/** Filtros em forma canônica para comparação: valores de lista ordenados, chaves ordenadas. */
function canonicalFilters(filters: SavedViewFilters): string {
  const params = paramsFromSavedViewFilters(filters);
  const entries = Object.entries(params)
    .map(([key, value]): [string, string] => [key, value.split(',').sort().join(',')])
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function canonicalColumns(
  columns: readonly ProcessColumnKey[],
  available: ReadonlySet<ProcessColumnKey> | undefined,
): string {
  const kept = columns.filter(
    (key) => columnIdOf(key) !== null && (available === undefined || available.has(key)),
  );
  return JSON.stringify([...new Set(kept)].sort());
}

/**
 * A lista atual difere da visão aplicada? Compara filtros (sem ordem de valores), ordenação e
 * conjunto de colunas — as que a tela não oferece (`tags`, órgão com um só órgão) não contam.
 */
export function hasUnsavedChanges(
  view: Pick<SavedViewDto, 'filters' | 'sort' | 'columns'>,
  current: ViewDefinition,
  available?: ReadonlySet<ProcessColumnKey>,
): boolean {
  const sortOf = (sort: string | null) =>
    sort === null || sort.trim() === '' ? null : sort.trim();
  return (
    canonicalFilters(view.filters) !== canonicalFilters(current.filters) ||
    sortOf(view.sort) !== sortOf(current.sort) ||
    canonicalColumns(view.columns, available) !== canonicalColumns(current.columns, available)
  );
}

// --- Resumo dos critérios ------------------------------------------------------------------

export interface CriteriaLabels {
  /** Rótulo do filtro ("Status"). */
  readonly filter: (key: ProcessListParamKey) => string;
  /** Valor legível do filtro ("Em andamento"). */
  readonly value: (key: ProcessListParamKey, raw: string) => string;
  /** Filtros booleanos ligados aparecem só pelo nome ("Atrasados"). */
  readonly flag: (key: 'overdue' | 'targetDateOverdue') => string;
  /** Um termo de ordenação ("Prioridade (decrescente)"). */
  readonly sortTerm: (field: string, direction: 'asc' | 'desc') => string;
  readonly sortPrefix: string;
  readonly empty: string;
}

const FLAG_KEYS: ReadonlySet<ProcessListParamKey> = new Set(['overdue', 'targetDateOverdue']);

/** "Status: Em andamento · Atrasados · Ordenação: Prioridade" — o que o diálogo mostra. */
export function summarizeCriteria(params: ListParams, labels: CriteriaLabels): string {
  const parts: string[] = [];
  for (const key of activeFilterKeys(params)) {
    const raw = params[key] ?? '';
    if (FLAG_KEYS.has(key) && raw === 'true') {
      parts.push(labels.flag(key as 'overdue' | 'targetDateOverdue'));
    } else {
      parts.push(`${labels.filter(key)}: ${labels.value(key, raw)}`);
    }
  }
  const terms = (params.sort ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term !== '')
    .map((term) =>
      term.startsWith('-')
        ? labels.sortTerm(term.slice(1), 'desc')
        : labels.sortTerm(term.replace(/^\+/, ''), 'asc'),
    );
  if (terms.length > 0) parts.push(`${labels.sortPrefix}: ${terms.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : labels.empty;
}

// --- Exportação (PRC-34) -------------------------------------------------------------------

/** Query de PRC-34: filtros e ordenação de PRC-01 sem paginação + `columns` (+ visão de origem). */
export function exportQuery(
  params: ListParams,
  columns: readonly ProcessColumnKey[],
  savedViewId?: string,
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'page' || key === 'pageSize' || key === 'includeStageOptions') continue;
    if (value !== '') query[key] = value;
  }
  query.columns = columns.join(',');
  if (savedViewId !== undefined) query.savedViewId = savedViewId;
  return query;
}

/** RN-PROC-41: a consulta passa do limite de linhas do arquivo? */
export const exceedsExportLimit = (total: number): boolean => total > PROCESS_EXPORT_MAX_ROWS;

export type ExportFailure =
  | { readonly kind: 'tooLarge'; readonly total: number | null }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'validation' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

/**
 * Erro de PRC-34 → falha tratada na tela. `apiDownload` converte a conexão que cai (antes do corpo
 * completo) em 503 sem corpo problem+json: sem `problem`, é interrupção (FA-08) — com `problem`,
 * é indisponibilidade antes do envio.
 */
export function classifyExportError(error: unknown): ExportFailure {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  if (error.status === 422 && error.code === 'EXPORT_TOO_LARGE') {
    const meta = error.problem?.meta;
    const total =
      typeof meta === 'object' && meta !== null && 'totalItems' in meta ? meta.totalItems : null;
    return { kind: 'tooLarge', total: typeof total === 'number' ? total : null };
  }
  if (error.status === 422) return { kind: 'validation' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.status === 429) {
    return { kind: 'rateLimited', retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error.status === 503 && error.problem === null) return { kind: 'interrupted' };
  if (error.status >= 500) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'unexpected', correlationId: error.correlationId };
}

/** Mensagem pt-BR de uma falha de exportação que vem das constantes compartilhadas com a API. */
export function exportFailureMessage(failure: ExportFailure): string | null {
  switch (failure.kind) {
    case 'tooLarge':
      return failure.total === null ? null : PROCESS_EXPORT_MESSAGES.tooLarge(failure.total);
    case 'rateLimited':
      return PROCESS_EXPORT_MESSAGES.inProgress;
    case 'forbidden':
      return PROCESS_EXPORT_MESSAGES.forbidden;
    case 'validation':
      return PROCESS_EXPORT_MESSAGES.invalidFilters;
    case 'interrupted':
      return PROCESS_EXPORT_MESSAGES.interrupted;
    case 'unavailable':
      return PROCESS_EXPORT_MESSAGES.unavailable;
    case 'unexpected':
      return null;
  }
}

/**
 * Linhas de dados de um CSV (RFC 4180, separador qualquer): ignora o BOM e o cabeçalho e não conta
 * quebras de linha dentro de aspas.
 */
export function countCsvRows(text: string): number {
  let records = 0;
  let inQuotes = false;
  let lineHasContent = false;
  for (const char of text.startsWith('\uFEFF') ? text.slice(1) : text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      lineHasContent = true;
    } else if (char === '\n' && !inQuotes) {
      if (lineHasContent) records += 1;
      lineHasContent = false;
    } else if (char !== '\r') {
      lineHasContent = true;
    }
  }
  if (lineHasContent) records += 1;
  return Math.max(0, records - 1);
}

// --- Erros de PRC-35..38 -------------------------------------------------------------------

export type ViewOperation = 'create' | 'change';
export type ViewFieldName = 'name' | 'filters' | 'columns';

export type ViewFailure =
  | { readonly kind: 'nameTaken' }
  | {
      readonly kind: 'validation';
      readonly fields: Readonly<Partial<Record<ViewFieldName, string>>>;
      /** Mensagem geral (limite de 20, padrão em visão compartilhada…); vazia se só houver campos. */
      readonly message: string | null;
    }
  | { readonly kind: 'notOwner' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'versionConflict' }
  | { readonly kind: 'precondition' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

const VIEW_FIELDS: readonly ViewFieldName[] = ['name', 'filters', 'columns'];
const FIELD_FALLBACKS: Readonly<Record<ViewFieldName, string>> = {
  name: SAVED_VIEW_MESSAGES.name,
  filters: SAVED_VIEW_MESSAGES.invalidFilters,
  columns: SAVED_VIEW_MESSAGES.invalidColumns,
};

/** Erro de PRC-35..38 → falha tratada na tela (campo, aviso ou recarga). */
export function classifyViewError(error: unknown, operation: ViewOperation): ViewFailure {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  switch (error.status) {
    case 409:
      return { kind: 'nameTaken' };
    case 422: {
      const fields: Partial<Record<ViewFieldName, string>> = {};
      let message: string | null = null;
      for (const item of error.errors) {
        const field = VIEW_FIELDS.find((name) => name === item.field);
        const text = item.message.trim();
        if (field !== undefined) fields[field] ??= text === '' ? FIELD_FALLBACKS[field] : text;
        else if (message === null && text !== '') message = text;
      }
      if (Object.keys(fields).length === 0 && message === null) {
        message = SAVED_VIEW_MESSAGES.invalid;
      }
      return { kind: 'validation', fields, message };
    }
    case 403:
      return operation === 'change' ? { kind: 'notOwner' } : { kind: 'forbidden' };
    case 404:
      return { kind: 'notFound' };
    case 412:
      return { kind: 'versionConflict' };
    case 428:
      return { kind: 'precondition' };
    default:
      return error.status >= 500
        ? { kind: 'unavailable', correlationId: error.correlationId }
        : { kind: 'unexpected', correlationId: error.correlationId };
  }
}

/** Mensagens da falha que a API/validação já definem em pt-BR (V-01..V-06 e "Casos de erro"). */
export function viewFailureMessage(failure: ViewFailure): string | null {
  switch (failure.kind) {
    case 'nameTaken':
      return SAVED_VIEW_MESSAGES.nameTaken;
    case 'validation':
      return failure.message ?? SAVED_VIEW_MESSAGES.invalid;
    case 'notOwner':
      return SAVED_VIEW_MESSAGES.notOwner;
    case 'notFound':
      return SAVED_VIEW_MESSAGES.notFound;
    case 'versionConflict':
      return SAVED_VIEW_MESSAGES.versionConflict;
    case 'precondition':
      return SAVED_VIEW_MESSAGES.preconditionRequired;
    case 'forbidden':
      return SAVED_VIEW_MESSAGES.forbidden;
    case 'unavailable':
    case 'unexpected':
      return null;
  }
}

/** V-01: nome de 1 a 80 caracteres após trim. */
export function validateViewName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= SAVED_VIEW_NAME_MAX
    ? null
    : SAVED_VIEW_MESSAGES.name;
}

// --- Listas --------------------------------------------------------------------------------

export interface GroupedViews {
  readonly mine: readonly SavedViewDto[];
  readonly shared: readonly SavedViewDto[];
}

const byName = (a: SavedViewDto, b: SavedViewDto) => a.name.localeCompare(b.name, 'pt-BR');

/** "Minhas visões" (padrão primeiro) e "Compartilhadas" (de outros), cada grupo por nome. */
export function groupViews(views: readonly SavedViewDto[]): GroupedViews {
  const mine = views.filter((view) => view.isOwner).sort(byName);
  const standard = mine.filter((view) => view.isDefault);
  return {
    mine: [...standard, ...mine.filter((view) => !view.isDefault)],
    shared: views.filter((view) => !view.isOwner).sort(byName),
  };
}

/** Visão padrão do usuário (FA-01): só a própria vale. */
export const findDefaultView = (views: readonly SavedViewDto[]): SavedViewDto | undefined =>
  views.find((view) => view.isDefault && view.isOwner);

/** Substitui/insere a visão na lista; marcar uma como padrão desmarca a padrão anterior (RN-PROC-36). */
export function upsertView(views: readonly SavedViewDto[], saved: SavedViewDto): SavedViewDto[] {
  const rest = views
    .filter((view) => view.id !== saved.id)
    .map((view) =>
      saved.isDefault && view.isOwner && view.isDefault ? { ...view, isDefault: false } : view,
    );
  const index = views.findIndex((view) => view.id === saved.id);
  if (index === -1) return [...rest, saved];
  const next = [...rest];
  next.splice(index, 0, saved);
  return next;
}
