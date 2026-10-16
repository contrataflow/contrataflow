'use client';

import type { MyPermissionsDto, PermissionScopeDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { createContext, createElement, useContext } from 'react';
import type { ReactNode } from 'react';

import { apiRequest } from '@/lib/api/client';
import { permissionKeys } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Permissões efetivas do usuário no tenant ativo (US-097 · ME-03 `GET /me/permissions` ·
 * permissions.md §9 · RN-IAM-106/107): a única fonte dos hooks de permissão. Conveniência de UI —
 * esconde/desabilita elementos; a decisão continua sendo da API em toda requisição. Enquanto ME-03
 * carrega (ou falha), nada protegido aparece: oculto, nunca habilitado por engano.
 */

/** Resposta de ME-03 (`{ permissions: [{ code, scopes }], implicit }`). */
export type EffectivePermissions = MyPermissionsDto;
export type PermissionScope = PermissionScopeDto;

/** Permissões mudam pouco: mesma janela de catálogos/settings (architecture.md §8.5). */
export const PERMISSIONS_STALE_TIME_MS = 5 * 60_000;

/** O usuário tem a permissão em algum escopo. */
export function hasPermission(effective: EffectivePermissions | undefined, code: string): boolean {
  return effective?.permissions.some((permission) => permission.code === code) ?? false;
}

/** Escopos em que a permissão vale (vazio sem ela). */
export function scopesOf(
  effective: EffectivePermissions | undefined,
  code: string,
): readonly PermissionScope[] {
  return effective?.permissions.find((permission) => permission.code === code)?.scopes ?? [];
}

export interface PermissionState {
  /** `true` só com a resposta da API em mãos (carregando ou em erro → `false`). */
  readonly allowed: boolean;
  readonly status: 'pending' | 'error' | 'success';
}

/** Permissões efetivas do usuário no tenant ativo (ME-03); `undefined` enquanto carrega ou em erro. */
export function useEffectivePermissionsQuery() {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: permissionKeys.all(tenantId),
    queryFn: async ({ signal }) =>
      (await apiRequest<EffectivePermissions>('/me/permissions', { signal })).data,
    staleTime: PERMISSIONS_STALE_TIME_MS,
    // Falha ao ler permissões só oculta ações; não derruba a página.
    throwOnError: false,
  });
}

export interface PermissionContextValue {
  readonly data: EffectivePermissions | undefined;
  readonly status: PermissionState['status'];
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

/**
 * `PermissionProvider` (US-097): carrega ME-03 uma vez no bootstrap da sessão do shell e entrega
 * a todas as telas; troca de instituição muda a chave (`['t', tenantId, 'me', 'permissions']`) e
 * recarrega.
 */
export function PermissionProvider({ children }: { readonly children: ReactNode }) {
  const query = useEffectivePermissionsQuery();
  return createElement(
    PermissionContext.Provider,
    { value: { data: query.data, status: query.status } },
    children,
  );
}

/**
 * Permissões efetivas: as do `PermissionProvider` ou, fora dele (telas isoladas em teste), a mesma
 * consulta de ME-03 — o cache do TanStack Query é o mesmo.
 */
export function useEffectivePermissions(): PermissionContextValue {
  const provided = useContext(PermissionContext);
  const query = useEffectivePermissionsQuery();
  return provided ?? { data: query.data, status: query.status };
}

/**
 * Permissão efetiva do usuário no tenant ativo (permissions.md §9: "tem em algum escopo").
 * Conveniência de UI: a API continua decidindo cada requisição (RN-IAM-107).
 */
export function usePermission(code: string): PermissionState {
  const { data, status } = useEffectivePermissions();
  return { allowed: hasPermission(data, code), status };
}
