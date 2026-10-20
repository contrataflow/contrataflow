import type { CatalogType } from '@contrataflow/types';
import type { CatalogItemDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Catálogos parametrizáveis (US-104 · SCR-109): CAT-01..06 de api/14-tenant-administration.md. As
 * chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const catalogKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'catalogs'),
  items: (tenantId: string, catalogType: CatalogType) =>
    tenantKey(tenantId, 'catalogs', catalogType, 'items'),
};

/** Staleness dos catálogos (architecture.md §8.5: catálogos e configurações). */
export const CATALOGS_STALE_TIME_MS = 5 * 60_000;

/** Dezenas de itens por catálogo: uma única página de 100 (máximo da API) basta. */
const PAGE_SIZE = 100;

/** CAT-01: todos os itens (ativos e inativos) por `sortOrder`. */
export function fetchCatalogItems(
  catalogType: CatalogType,
  signal?: AbortSignal,
): Promise<ApiResult<CatalogItemDto[]>> {
  return apiRequest<CatalogItemDto[]>(`/catalogs/${catalogType}/items`, {
    query: { page: 1, pageSize: PAGE_SIZE },
    signal,
  });
}

export interface CatalogItemBody {
  readonly code?: string;
  readonly label?: string;
  readonly description?: string | null;
  readonly parentId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** CAT-02. */
export function createCatalogItem(
  catalogType: CatalogType,
  body: CatalogItemBody,
): Promise<ApiResult<CatalogItemDto>> {
  return apiRequest<CatalogItemDto>(`/catalogs/${catalogType}/items`, { method: 'POST', body });
}

/** CAT-03: só os campos alterados, com a versão lida em `If-Match`. */
export function updateCatalogItem(
  id: string,
  patch: CatalogItemBody,
  version: number,
): Promise<ApiResult<CatalogItemDto>> {
  return apiRequest<CatalogItemDto>(`/catalog-items/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** CAT-04/CAT-05: ativar e desativar, com `If-Match`. */
export function setCatalogItemActive(
  id: string,
  isActive: boolean,
  version: number,
): Promise<ApiResult<CatalogItemDto>> {
  return apiRequest<CatalogItemDto>(
    `/catalog-items/${id}/${isActive ? 'activate' : 'deactivate'}`,
    {
      method: 'POST',
      body: {},
      ifMatch: `"${version}"`,
    },
  );
}

/** CAT-06: lista completa de IDs do catálogo na nova ordem. */
export function reorderCatalogItems(
  catalogType: CatalogType,
  orderedIds: readonly string[],
): Promise<ApiResult<CatalogItemDto[]>> {
  return apiRequest<CatalogItemDto[]>(`/catalogs/${catalogType}/order`, {
    method: 'PUT',
    body: { orderedIds },
  });
}
