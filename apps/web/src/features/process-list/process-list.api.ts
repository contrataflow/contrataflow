import type { CatalogType } from '@contrataflow/types';
import type {
  CatalogItemDto,
  OrganizationDto,
  ProcessListItemDto,
  ProcessListMeta,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Leituras de SCR-004 (US-002): PRC-01 e as leituras de apoio às opções de filtro (CAT-01, ORG-01,
 * DEP-02). Chaves `['t', tenantId, …]` (RN-FND-90). Preferência de colunas (RN-PROC-32) em
 * `User.preferences` via ME-02, com contingência local (`localStorage`).
 */

export const processListKeys = {
  list: (tenantId: string, params: Readonly<Record<string, string>>) =>
    tenantKey(tenantId, 'processes', 'list', params),
  catalog: (tenantId: string, type: CatalogType) => tenantKey(tenantId, 'catalogs', type, 'all'),
  organizations: (tenantId: string) => tenantKey(tenantId, 'organizations', 'list'),
  departments: (tenantId: string) => tenantKey(tenantId, 'departments', 'lookup'),
};

/** US-002 · "Frontend · Dados": `staleTime` 30 s e refetch ao focar a janela. */
export const PROCESS_LIST_STALE_TIME_MS = 30_000;
export const FILTER_OPTIONS_STALE_TIME_MS = 10 * 60_000;

export interface ProcessListPage {
  readonly items: ProcessListItemDto[];
  readonly meta: ProcessListMeta;
  readonly correlationId: string | null;
}

/** PRC-01. */
export async function fetchProcessList(
  query: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ProcessListPage> {
  const result = await apiRequest<ProcessListItemDto[]>('/processes', { query, signal });
  const meta = result.meta as unknown as ProcessListMeta;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    meta: {
      page: meta.page,
      pageSize: meta.pageSize,
      totalItems: meta.totalItems,
      totalPages: meta.totalPages,
      ...(meta.stageOptions ? { stageOptions: meta.stageOptions } : {}),
      ...(meta.valueFilterExcludesConfidential !== undefined
        ? { valueFilterExcludesConfidential: meta.valueFilterExcludesConfidential }
        : {}),
      ...(meta.confidentialStepUpAvailable ? { confidentialStepUpAvailable: true } : {}),
    },
    correlationId: result.meta.correlationId,
  };
}

/** CAT-01: itens ativos E inativos (o filtro casa processos antigos — tabela "Campos"). */
export async function fetchCatalogOptions(
  type: CatalogType,
  signal?: AbortSignal,
): Promise<CatalogItemDto[]> {
  return (
    await apiRequest<CatalogItemDto[]>(`/catalogs/${type}/items`, {
      query: { page: 1, pageSize: 100 },
      signal,
    })
  ).data;
}

/** ORG-01: o filtro e a coluna "Órgão" só aparecem com mais de um órgão (FA-08). */
export async function fetchOrganizations(signal?: AbortSignal): Promise<OrganizationDto[]> {
  return (
    await apiRequest<OrganizationDto[]>('/organizations', {
      query: { page: 1, pageSize: 100 },
      signal,
    })
  ).data;
}

export interface UnitOption {
  readonly id: string;
  readonly name: string;
}

/** DEP-02: unidades ativas para seleção (até 50). */
export async function fetchUnitOptions(signal?: AbortSignal): Promise<UnitOption[]> {
  const result = await apiRequest<UnitOption[]>('/departments/lookup', { signal });
  return Array.isArray(result.data) ? result.data.map(({ id, name }) => ({ id, name })) : [];
}

// --- Colunas (RN-PROC-32) ------------------------------------------------------------------

export const columnsPreferenceKey = (tenantId: string) => `processList.${tenantId}.columns`;

/** Colunas guardadas localmente (`null` = nenhuma escolha ou armazenamento indisponível). */
export function readStoredColumns(tenantId: string): string[] | null {
  try {
    const raw = globalThis.localStorage.getItem(columnsPreferenceKey(tenantId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function storeColumnsLocally(tenantId: string, columns: readonly string[]): void {
  try {
    globalThis.localStorage.setItem(columnsPreferenceKey(tenantId), JSON.stringify(columns));
  } catch {
    // Armazenamento local indisponível: a escolha vale só nesta tela.
  }
}

/**
 * Persiste a escolha: local sempre (aplicação imediata e contingência) e em `User.preferences`
 * pelo ME-02. Devolve `false` quando a gravação no servidor falhou (aviso discreto). ME-02 ainda
 * ausente (404/405 — US-098) não é falha: a escolha fica só neste dispositivo, sem aviso.
 */
export async function saveColumnsPreference(
  tenantId: string,
  columns: readonly string[],
): Promise<boolean> {
  storeColumnsLocally(tenantId, columns);
  try {
    await apiRequest('/me', {
      method: 'PATCH',
      body: { preferences: { [columnsPreferenceKey(tenantId)]: columns } },
    });
    return true;
  } catch (error) {
    return isApiError(error) && (error.status === 404 || error.status === 405);
  }
}
