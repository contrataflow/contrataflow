import type {
  AcceptedInvitationDto,
  DepartmentLookupItem,
  InvitationPreviewDto,
  InvitationResentDto,
  InviteUser,
  MembershipDetailMeta,
  MembershipReason,
  RoleDto,
  TenantMembershipDetailDto,
  TenantMembershipDto,
  UpdateMembership,
  UpdateMembershipDepartments,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Usuários e convites (US-091 · SCR-029/SCR-102): USR-01, USR-03..06 e USR-14 de
 * api/14-tenant-administration.md, mais os seletores DEP-02 e ROL-02. Gestão de vínculos
 * (US-092): USR-07..12. Chaves `['t', tenantId, …]` (RN-FND-90).
 */

export interface UserListFilters {
  /** Busca por nome/e-mail; só vai à API com ≥ 2 caracteres. */
  readonly q: string;
  /** Um status ou `''` (todos, exceto convites — eles têm a seção própria). */
  readonly status: string;
  readonly type: '' | 'INTERNAL' | 'EXTERNAL';
  readonly departmentId: string;
}

export const EMPTY_USER_FILTERS: UserListFilters = {
  q: '',
  status: '',
  type: '',
  departmentId: '',
};

/** Status do filtro "Todos": os convites pendentes aparecem na própria seção. */
export const ALL_STATUSES_EXCEPT_INVITED = 'ACTIVE,SUSPENDED,REVOKED,EXPIRED';
export const USER_STATUS_FILTERS = ['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'] as const;

export const userKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'users'),
  lists: (tenantId: string) => tenantKey(tenantId, 'users', 'list'),
  list: (tenantId: string, filters: UserListFilters, page: number) =>
    tenantKey(tenantId, 'users', 'list', filters, page),
  detail: (tenantId: string, userId: string) => tenantKey(tenantId, 'users', 'detail', userId),
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
export const USERS_PAGE_SIZE = 20;
/** O detalhe tem `If-Match`: janela curta para não editar sobre dado velho. */
export const USER_DETAIL_STALE_TIME_MS = 30_000;

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

export interface UsersPage {
  readonly items: TenantMembershipDto[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
}

/** USR-01 com busca (≥ 2 caracteres) e filtros por status, tipo e lotação. */
export async function fetchUsers(
  filters: UserListFilters,
  page: number,
  signal?: AbortSignal,
): Promise<UsersPage> {
  const q = filters.q.trim();
  const result = await apiRequest<TenantMembershipDto[]>('/users', {
    query: {
      q: q.length >= 2 ? q : undefined,
      status: filters.status === '' ? ALL_STATUSES_EXCEPT_INVITED : filters.status,
      type: filters.type === '' ? undefined : filters.type,
      departmentId: filters.departmentId === '' ? undefined : filters.departmentId,
      page,
      pageSize: USERS_PAGE_SIZE,
    },
    signal,
  });
  const meta = result.meta as PageMeta & { totalItems?: number };
  return {
    items: result.data,
    page: meta.page ?? page,
    totalPages: meta.totalPages ?? 1,
    totalItems: meta.totalItems ?? result.data.length,
  };
}

/** Detalhe do vínculo (USR-07..12): o recurso e `meta.allowedActions`/`isSelf`. */
export interface UserDetailResult {
  readonly membership: TenantMembershipDetailDto;
  readonly meta: MembershipDetailMeta;
}

function toDetailResult(result: ApiResult<TenantMembershipDetailDto>): UserDetailResult {
  const meta = result.meta as Partial<MembershipDetailMeta>;
  return {
    membership: result.data,
    meta: { allowedActions: meta.allowedActions ?? [], isSelf: meta.isSelf ?? false },
  };
}

/** `If-Match` com a `version` lida no detalhe. */
const ifMatchOf = (version: number) => `"${String(version)}"`;

/** USR-07. */
export async function fetchUser(userId: string, signal?: AbortSignal): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}`, { signal }),
  );
}

/** USR-08: só os campos alterados. */
export async function updateUser(
  userId: string,
  patch: UpdateMembership,
  version: number,
): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}`, {
      method: 'PATCH',
      body: patch,
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** USR-09: substitui o conjunto de lotações. */
export async function updateUserDepartments(
  userId: string,
  body: UpdateMembershipDepartments,
  version: number,
): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}/departments`, {
      method: 'PUT',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** USR-10. */
export async function suspendUser(
  userId: string,
  body: MembershipReason,
  version: number,
): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}/suspend`, {
      method: 'POST',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** USR-11. */
export async function reactivateUser(userId: string, version: number): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}/reactivate`, {
      method: 'POST',
      body: {},
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** USR-12 (definitivo: reverter exige novo convite). */
export async function revokeUser(
  userId: string,
  body: MembershipReason,
  version: number,
): Promise<UserDetailResult> {
  return toDetailResult(
    await apiRequest<TenantMembershipDetailDto>(`/users/${userId}/revoke`, {
      method: 'POST',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
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
