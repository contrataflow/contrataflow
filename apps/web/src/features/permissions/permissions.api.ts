import type { PermissionDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Catálogo de permissões (US-094 · ROL-01 de api/02-access.md). O catálogo é global e estável
 * (muda só por migração), por isso a staleness é alta; a chave segue `['t', tenantId, 'permissions']`
 * (SCR-031 · RN-FND-90) para não sobreviver à troca de instituição.
 */

export const permissionCatalogKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'permissions'),
};

/** O catálogo só muda por deploy; 60 min evitam reler os 68 itens a cada visita. */
export const PERMISSION_CATALOG_STALE_TIME_MS = 60 * 60_000;

export function fetchPermissionCatalog(signal?: AbortSignal): Promise<ApiResult<PermissionDto[]>> {
  return apiRequest<PermissionDto[]>('/permissions', { signal });
}
