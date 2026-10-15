import type {
  CreateDepartmentInput,
  DepartmentDto,
  UpdateDepartmentInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Secretarias e setores (US-102 · SCR-032, aba "Secretarias"): DEP-01..09 de
 * api/14-tenant-administration.md. As chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const departmentKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'departments'),
  tree: (tenantId: string, organizationId: string) =>
    tenantKey(tenantId, 'departments', 'tree', organizationId),
};

/** Staleness da estrutura (architecture.md §8.5: catálogos e configurações). */
export const DEPARTMENTS_STALE_TIME_MS = 5 * 60_000;

/** Máximo da API por página; a árvore do órgão é lida inteira, página a página. */
const PAGE_SIZE = 100;

interface PageMeta {
  readonly totalItems?: number;
}

/** DEP-01: todas as unidades do órgão, na ordem da árvore (pais antes dos filhos). */
export async function fetchDepartmentTree(
  organizationId: string,
  signal?: AbortSignal,
): Promise<DepartmentDto[]> {
  const all: DepartmentDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await apiRequest<DepartmentDto[]>('/departments', {
      query: { organizationId, page, pageSize: PAGE_SIZE },
      signal,
    });
    all.push(...result.data);
    const total = (result.meta as PageMeta | undefined)?.totalItems ?? all.length;
    if (result.data.length < PAGE_SIZE || all.length >= total) return all;
  }
}

/** DEP-04 (relê a unidade no 412). */
export function fetchDepartment(id: string): Promise<ApiResult<DepartmentDto>> {
  return apiRequest<DepartmentDto>(`/departments/${id}`);
}

/** DEP-03; a `Idempotency-Key` é a mesma em cada repetição da mesma criação. */
export function createDepartment(
  body: CreateDepartmentInput,
  idempotencyKey?: string,
): Promise<ApiResult<DepartmentDto>> {
  return apiRequest<DepartmentDto>('/departments', {
    method: 'POST',
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** DEP-05: só os campos alterados, com a versão lida em `If-Match`. */
export function updateDepartment(
  id: string,
  patch: UpdateDepartmentInput,
  version: number,
): Promise<ApiResult<DepartmentDto>> {
  return apiRequest<DepartmentDto>(`/departments/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** DEP-06: `parentId` nulo = raiz do órgão. */
export function moveDepartment(
  id: string,
  parentId: string | null,
  version: number,
): Promise<ApiResult<DepartmentDto>> {
  return apiRequest<DepartmentDto>(`/departments/${id}/move`, {
    method: 'POST',
    body: { parentId },
    ifMatch: `"${version}"`,
  });
}

/** DEP-07/08. */
export function setDepartmentActive(
  id: string,
  isActive: boolean,
  version: number,
): Promise<ApiResult<DepartmentDto>> {
  return apiRequest<DepartmentDto>(`/departments/${id}/${isActive ? 'activate' : 'deactivate'}`, {
    method: 'POST',
    body: {},
    ifMatch: `"${version}"`,
  });
}

/** DEP-09 (só sem referências; 409 → oferecer "Desativar"). */
export async function deleteDepartment(id: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/departments/${id}`, { method: 'DELETE', ifMatch: `"${version}"` });
}
