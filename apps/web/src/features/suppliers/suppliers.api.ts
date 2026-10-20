import type {
  CreateSupplierInput,
  SupplierDto,
  UpdateSupplierInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Fornecedores (US-025 · SCR-107): SUP-01..06 de api/07-price-research-suppliers.md. As chaves
 * seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export interface SupplierListFilters {
  /** Busca por razão social, nome fantasia ou documento; só vai à API com ≥ 2 caracteres. */
  readonly q: string;
  /** `''` = todos; `'true'`/`'false'` = só ativos/inativos. */
  readonly isActive: '' | 'true' | 'false';
}

export const EMPTY_SUPPLIER_FILTERS: SupplierListFilters = { q: '', isActive: '' };

export const supplierKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'suppliers'),
  list: (tenantId: string, filters: SupplierListFilters, page: number) =>
    tenantKey(tenantId, 'suppliers', 'list', filters, page),
  lookup: (tenantId: string, documentNumber: string) =>
    tenantKey(tenantId, 'suppliers', 'lookup', documentNumber),
};

/** Fornecedores mudam com pouca frequência, mas têm `If-Match`: janela curta. */
export const SUPPLIERS_STALE_TIME_MS = 30_000;
export const SUPPLIERS_PAGE_SIZE = 20;

interface PageMeta {
  readonly page?: number;
  readonly totalPages?: number;
  readonly totalItems?: number;
}

export interface SuppliersPage {
  readonly items: SupplierDto[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
}

/** SUP-01 com busca (≥ 2 caracteres) e filtro Ativos/Inativos. */
export async function fetchSuppliers(
  filters: SupplierListFilters,
  page: number,
  signal?: AbortSignal,
): Promise<SuppliersPage> {
  const q = filters.q.trim();
  const result = await apiRequest<SupplierDto[]>('/suppliers', {
    query: {
      q: q.length >= 2 ? q : undefined,
      isActive: filters.isActive === '' ? undefined : filters.isActive,
      page,
      pageSize: SUPPLIERS_PAGE_SIZE,
    },
    signal,
  });
  const meta = result.meta as PageMeta;
  return {
    items: result.data,
    page: meta.page ?? page,
    totalPages: meta.totalPages ?? 1,
    totalItems: meta.totalItems ?? result.data.length,
  };
}

/** SUP-03 (relê o fornecedor no 412). */
export function fetchSupplier(id: string): Promise<ApiResult<SupplierDto>> {
  return apiRequest<SupplierDto>(`/suppliers/${id}`);
}

/** SUP-06: fornecedor do tenant com o documento informado, ou `null`. */
export async function lookupSupplier(
  documentNumber: string,
  signal?: AbortSignal,
): Promise<SupplierDto | null> {
  const result = await apiRequest<SupplierDto | null>('/suppliers/lookup', {
    query: { documentNumber },
    signal,
  });
  return result.data;
}

/** SUP-02; a `Idempotency-Key` é a mesma em cada repetição da mesma criação. */
export function createSupplier(
  body: CreateSupplierInput,
  idempotencyKey?: string,
): Promise<ApiResult<SupplierDto>> {
  return apiRequest<SupplierDto>('/suppliers', {
    method: 'POST',
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** SUP-04: só os campos alterados (e `isActive`), com a versão lida em `If-Match`. */
export function updateSupplier(
  id: string,
  patch: UpdateSupplierInput,
  version: number,
): Promise<ApiResult<SupplierDto>> {
  return apiRequest<SupplierDto>(`/suppliers/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** SUP-05 (exclusão lógica; fornecedor em uso → 409 `SUPPLIER_IN_USE`). */
export async function deleteSupplier(id: string, version: number): Promise<void> {
  await apiRequest<undefined>(`/suppliers/${id}`, { method: 'DELETE', ifMatch: `"${version}"` });
}
