'use client';

import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { permissionKeys } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/** Resposta de ME-03 (`GET /api/v1/me/permissions`). */
export interface EffectivePermissions {
  readonly permissions: readonly { readonly code: string; readonly scopes: readonly string[] }[];
  readonly implicit?: unknown;
}

/** Permissões mudam pouco: mesma janela de catálogos/settings (architecture.md §8.5). */
export const PERMISSIONS_STALE_TIME_MS = 5 * 60_000;

export function hasPermission(effective: EffectivePermissions | undefined, code: string): boolean {
  return effective?.permissions.some((permission) => permission.code === code) ?? false;
}

export interface PermissionState {
  /** `true` só com a resposta da API em mãos (carregando ou em erro → `false`). */
  readonly allowed: boolean;
  readonly status: 'pending' | 'error' | 'success';
}

/**
 * Permissão efetiva do usuário no tenant ativo (ME-03 · permissions.md §9). Conveniência de UI:
 * a API continua decidindo cada requisição (RN-FND-92).
 */
export function usePermission(code: string): PermissionState {
  const tenantId = useTenantId();
  const query = useQuery({
    queryKey: permissionKeys.all(tenantId),
    queryFn: async ({ signal }) =>
      (await apiRequest<EffectivePermissions>('/me/permissions', { signal })).data,
    staleTime: PERMISSIONS_STALE_TIME_MS,
    // Falha ao ler permissões só oculta ações; não derruba a página.
    throwOnError: false,
  });
  return { allowed: hasPermission(query.data, code), status: query.status };
}
