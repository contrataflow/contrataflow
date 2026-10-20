import type {
  CreateRoleInput,
  RoleDto,
  RoleWithPermissionsDto,
  UpdateRoleInput,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Perfis e matriz de permissões (US-095 · SCR-030/031): ROL-02..08 de
 * api/14-tenant-administration.md. Chaves `['t', tenantId, 'roles']` e
 * `['t', tenantId, 'roles', roleId]` (RN-FND-90).
 */

export const roleKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'roles'),
  detail: (tenantId: string, roleId: string) => tenantKey(tenantId, 'roles', roleId),
};

/** Staleness da administração (architecture.md §8.5: catálogos e configurações). */
export const ROLES_STALE_TIME_MS = 5 * 60_000;

/** ROL-02. */
export function fetchRoles(signal?: AbortSignal): Promise<ApiResult<RoleDto[]>> {
  return apiRequest<RoleDto[]>('/roles', { signal });
}

/** ROL-04 (com a matriz). */
export function fetchRole(
  roleId: string,
  signal?: AbortSignal,
): Promise<ApiResult<RoleWithPermissionsDto>> {
  return apiRequest<RoleWithPermissionsDto>(`/roles/${roleId}`, { signal });
}

/** ROL-03. */
export function createRole(body: CreateRoleInput): Promise<ApiResult<RoleDto>> {
  return apiRequest<RoleDto>('/roles', { method: 'POST', body });
}

/** ROL-05: só os campos alterados, com a versão lida em `If-Match`. */
export function updateRole(
  roleId: string,
  patch: UpdateRoleInput,
  version: number,
): Promise<ApiResult<RoleDto>> {
  return apiRequest<RoleDto>(`/roles/${roleId}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** ROL-06: a lista COMPLETA de códigos marcados. */
export function updateRolePermissions(
  roleId: string,
  permissions: readonly string[],
  version: number,
): Promise<ApiResult<RoleWithPermissionsDto>> {
  return apiRequest<RoleWithPermissionsDto>(`/roles/${roleId}/permissions`, {
    method: 'PUT',
    body: { permissions },
    ifMatch: `"${version}"`,
  });
}

/** ROL-07. */
export function duplicateRole(roleId: string): Promise<ApiResult<RoleDto>> {
  return apiRequest<RoleDto>(`/roles/${roleId}/duplicate`, { method: 'POST', body: {} });
}

/** ROL-08 (FA-04: `confirmDeactivate` quando há vínculos ativos). */
export function deactivateRole(
  roleId: string,
  version: number,
  confirmDeactivate: boolean,
): Promise<ApiResult<RoleDto>> {
  return apiRequest<RoleDto>(`/roles/${roleId}/deactivate`, {
    method: 'POST',
    body: confirmDeactivate ? { confirmDeactivate: true } : {},
    ifMatch: `"${version}"`,
  });
}
