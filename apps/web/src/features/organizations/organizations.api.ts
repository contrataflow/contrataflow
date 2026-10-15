import type {
  CreateOrganizationInput,
  OrganizationDto,
  UpdateOrganizationInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Órgãos (US-101 · SCR-032): ORG-01..04 de api/14-tenant-administration.md. As chaves seguem a
 * convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const organizationKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'organizations'),
  list: (tenantId: string) => tenantKey(tenantId, 'organizations', 'list'),
};

/** Staleness da lista administrativa (architecture.md §8.5: catálogos e configurações). */
export const ORGANIZATIONS_STALE_TIME_MS = 5 * 60_000;

/** Dezenas de órgãos por tenant: uma única página de 100 (máximo da API) basta. */
const PAGE_SIZE = 100;

/** ORG-01. */
export function fetchOrganizations(signal?: AbortSignal): Promise<ApiResult<OrganizationDto[]>> {
  return apiRequest<OrganizationDto[]>('/organizations', {
    query: { page: 1, pageSize: PAGE_SIZE },
    signal,
  });
}

/** ORG-03 (relê o órgão no 412). */
export function fetchOrganization(id: string): Promise<ApiResult<OrganizationDto>> {
  return apiRequest<OrganizationDto>(`/organizations/${id}`);
}

/** ORG-02. */
export function createOrganization(
  body: CreateOrganizationInput,
): Promise<ApiResult<OrganizationDto>> {
  return apiRequest<OrganizationDto>('/organizations', { method: 'POST', body });
}

/** ORG-04: só os campos alterados, com a versão lida em `If-Match`. */
export function updateOrganization(
  id: string,
  patch: UpdateOrganizationInput,
  version: number,
): Promise<ApiResult<OrganizationDto>> {
  return apiRequest<OrganizationDto>(`/organizations/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}
