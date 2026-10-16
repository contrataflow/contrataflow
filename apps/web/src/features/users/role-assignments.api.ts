import type {
  AssignRole,
  OrganizationDto,
  RoleAssignmentDto,
  RoleAssignmentListMeta,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Perfis e acessos do usuário (US-096 · SCR-029, aba "Perfis e acessos"): ROL-10..12 de
 * api/14-tenant-administration.md, mais o seletor de órgãos (ORG-01). Chaves `['t', tenantId, …]`
 * (RN-FND-90).
 */

export const roleAssignmentKeys = {
  ofUser: (tenantId: string, userId: string) =>
    tenantKey(tenantId, 'users', 'role-assignments', userId),
  activeOrganizations: (tenantId: string) => tenantKey(tenantId, 'organizations', 'active'),
};

export const ROLE_ASSIGNMENTS_STALE_TIME_MS = 30_000;

/** ROL-10: a lista e se o ator pode atribuir/revogar (`ROLE_ASSIGN`) e se é ele mesmo (POL-16). */
export interface RoleAssignmentsResult {
  readonly assignments: RoleAssignmentDto[];
  readonly meta: RoleAssignmentListMeta;
}

export async function fetchRoleAssignments(
  userId: string,
  signal?: AbortSignal,
): Promise<RoleAssignmentsResult> {
  const result = await apiRequest<RoleAssignmentDto[]>(`/users/${userId}/role-assignments`, {
    signal,
  });
  const meta = result.meta as Partial<RoleAssignmentListMeta>;
  return {
    assignments: result.data,
    meta: { canAssign: meta.canAssign ?? false, isSelf: meta.isSelf ?? false },
  };
}

/** ROL-11; a mesma `Idempotency-Key` vale para cada repetição da mesma intenção. */
export function assignRole(
  userId: string,
  body: AssignRole,
  idempotencyKey: string,
): Promise<ApiResult<RoleAssignmentDto>> {
  return apiRequest<RoleAssignmentDto>(`/users/${userId}/role-assignments`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/** ROL-12 com `If-Match` da versão listada. */
export function revokeRoleAssignment(
  assignment: Pick<RoleAssignmentDto, 'id' | 'version'>,
  reason: string | null,
): Promise<ApiResult<RoleAssignmentDto>> {
  return apiRequest<RoleAssignmentDto>(`/role-assignments/${assignment.id}/revoke`, {
    method: 'POST',
    body: reason === null ? {} : { reason },
    ifMatch: `"${String(assignment.version)}"`,
  });
}

/** ORG-01 só com órgãos ativos (escopo `ORGANIZATION`). */
export function fetchActiveOrganizations(
  signal?: AbortSignal,
): Promise<ApiResult<OrganizationDto[]>> {
  return apiRequest<OrganizationDto[]>('/organizations', {
    query: { isActive: true, page: 1, pageSize: 100 },
    signal,
  });
}
