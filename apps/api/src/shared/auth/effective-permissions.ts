import type { PermissionCode } from '@contrataflow/types';

/*
 * Permissões efetivas do vínculo (US-097 · permissions.md §1.2 · DEC-134): os pares
 * `(permissão, escopo)` das atribuições VIGENTES (`validFrom ≤ now < validUntil`, não revogadas,
 * perfil ativo), com as unidades de cada escopo já expandidas (subárvore e lotação). É o valor
 * guardado no cache `cf:{env}:t:{tenantId}:access:eff:{membershipId}` e no contexto da requisição
 * pelo `AuthorizationGuard`. Dado puro (serializável): o comportamento fica no
 * `EffectivePermissionSet` do módulo `access`.
 */

export type PermissionScopeType = 'TENANT' | 'ORGANIZATION' | 'DEPARTMENT' | 'OWN_DEPARTMENTS';

/** Escopo de uma atribuição vigente (permissions.md §1). */
export interface EffectiveScope {
  readonly type: PermissionScopeType;
  readonly organizationId: string | null;
  readonly departmentId: string | null;
  readonly includeSubtree: boolean;
  /**
   * Unidades cobertas, já expandidas: `DEPARTMENT` = a unidade (e a subárvore, se
   * `includeSubtree`); `OWN_DEPARTMENTS` = as lotações do usuário (e as subárvores). Vazio em
   * `TENANT`/`ORGANIZATION`.
   */
  readonly departmentIds: readonly string[];
}

/** Permissões de um mesmo escopo (atribuições de escopo idêntico agrupadas). */
export interface EffectiveGrant {
  readonly scope: EffectiveScope;
  readonly permissions: readonly PermissionCode[];
}

export interface EffectivePermissionsSnapshot {
  readonly membershipId: string;
  readonly userId: string;
  readonly grants: readonly EffectiveGrant[];
  /** Unidades de lotação (`MembershipDepartment`) — custódia e escopo `OWN_DEPARTMENTS`. */
  readonly ownDepartmentIds: readonly string[];
  /** Unidades ativas de que o usuário é titular ou substituto (capacidade implícita — §7). */
  readonly headOfDepartmentIds: readonly string[];
  /** Quando foi calculado (ISO 8601). */
  readonly computedAt: string;
}
