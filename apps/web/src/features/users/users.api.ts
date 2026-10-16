import type {
  AcceptedInvitationDto,
  DepartmentLookupItem,
  InvitationPreviewDto,
  InvitationResentDto,
  InviteUser,
  RoleDto,
  TenantMembershipDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Usuários e convites (US-091 · SCR-029/SCR-102): USR-01, USR-03..06 e USR-14 de
 * api/14-tenant-administration.md, mais os seletores DEP-02 e ROL-02. Chaves `['t', tenantId, …]`
 * (RN-FND-90).
 */

export const userKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'users'),
  invitations: (tenantId: string) => tenantKey(tenantId, 'users', 'invitations'),
  invitationsPage: (tenantId: string, page: number) =>
    tenantKey(tenantId, 'users', 'invitations', page),
  departmentLookup: (tenantId: string, q: string) =>
    tenantKey(tenantId, 'departments', 'lookup', q),
  activeRoles: (tenantId: string) => tenantKey(tenantId, 'roles', 'active'),
};

/** Convites mudam com frequência: janela curta. */
export const INVITATIONS_STALE_TIME_MS = 30_000;
/** Seletores (catálogos): mesma janela de configurações (architecture.md §8.5). */
export const LOOKUP_STALE_TIME_MS = 5 * 60_000;

export const INVITATIONS_PAGE_SIZE = 20;

export interface InvitationsPage {
  readonly items: TenantMembershipDto[];
  readonly page: number;
  readonly totalPages: number;
}

interface PageMeta {
  readonly page?: number;
  readonly totalPages?: number;
}

/** USR-01 com `status=INVITED`. */
export async function fetchPendingInvitations(
  page: number,
  signal?: AbortSignal,
): Promise<InvitationsPage> {
  const result = await apiRequest<TenantMembershipDto[]>('/users', {
    query: { status: 'INVITED', page, pageSize: INVITATIONS_PAGE_SIZE },
    signal,
  });
  const meta = result.meta as PageMeta;
  return { items: result.data, page: meta.page ?? page, totalPages: meta.totalPages ?? 1 };
}

/** USR-03; a mesma `Idempotency-Key` vale para cada repetição da mesma intenção. */
export function inviteUser(
  body: InviteUser,
  idempotencyKey: string,
  correlationId?: string,
): Promise<ApiResult<TenantMembershipDto>> {
  return apiRequest<TenantMembershipDto>('/users/invitations', {
    method: 'POST',
    body,
    idempotencyKey,
    ...(correlationId ? { correlationId } : {}),
  });
}

/** USR-04. */
export function resendInvitation(userId: string): Promise<ApiResult<InvitationResentDto>> {
  return apiRequest<InvitationResentDto>(`/users/invitations/${userId}/resend`, {
    method: 'POST',
    body: {},
  });
}

/** USR-05. */
export async function cancelInvitation(userId: string): Promise<void> {
  await apiRequest<unknown>(`/users/invitations/${userId}`, { method: 'DELETE' });
}

/** USR-14 (sem tenant ativo; só sessão). */
export function previewInvitation(
  token: string,
  signal?: AbortSignal,
): Promise<ApiResult<InvitationPreviewDto>> {
  return apiRequest<InvitationPreviewDto>('/invitations/preview', {
    method: 'POST',
    body: { token },
    signal,
  });
}

/** USR-06 (sem tenant ativo; só sessão). */
export function acceptInvitation(token: string): Promise<ApiResult<AcceptedInvitationDto>> {
  return apiRequest<AcceptedInvitationDto>('/invitations/accept', {
    method: 'POST',
    body: { token },
  });
}

/** DEP-02: até 50 unidades ativas; `q` (≥ 2 caracteres) filtra por nome. */
export function lookupDepartments(
  q: string,
  signal?: AbortSignal,
): Promise<ApiResult<DepartmentLookupItem[]>> {
  return apiRequest<DepartmentLookupItem[]>('/departments/lookup', {
    query: { q: q.trim().length >= 2 ? q.trim() : undefined },
    signal,
  });
}

/** ROL-02 só com perfis ativos (403 sem `ROLE_VIEW`). */
export function fetchActiveRoles(signal?: AbortSignal): Promise<ApiResult<RoleDto[]>> {
  return apiRequest<RoleDto[]>('/roles', { query: { isActive: true }, signal });
}
