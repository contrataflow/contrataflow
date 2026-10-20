import type { AssignmentScope } from './role-assignment.js';

/*
 * Competência para aprovar por perfil (DEC-022 · POL-03 · RN-TRAM-47 da US-051): é aprovador o
 * detentor do perfil cuja ATRIBUIÇÃO cubra a unidade solicitante do processo — escopo `TENANT`,
 * `ORGANIZATION` = órgão do processo, ou `DEPARTMENT`/`OWN_DEPARTMENTS` (com a subárvore, quando
 * a atribuição a inclui) contendo a secretaria ou o setor solicitante. As concessões de
 * visibilidade (`ProcessAccess` `CURRENT`/`HISTORICAL`) nunca entram aqui. Funções puras.
 */

/** O processo como a competência o lê: o órgão e as unidades solicitantes. */
export interface RequestingUnits {
  readonly organizationId: string;
  /** Secretaria e setor solicitantes. */
  readonly departmentIds: readonly string[];
}

/** O que a competência precisa do detentor: lotações e as subárvores já lidas. */
export interface HolderUnits {
  readonly ownDepartmentIds: readonly string[];
  /** Raiz → ela e as descendentes (`competenceSubtreeRoots`). */
  readonly subtrees: ReadonlyMap<string, readonly string[]>;
}

/** Unidades de partida do escopo: a da atribuição (`DEPARTMENT`) ou as lotações. */
function scopeRoots(scope: AssignmentScope, ownDepartmentIds: readonly string[]): string[] {
  if (scope.scopeType === 'DEPARTMENT') {
    return scope.scopeDepartmentId === null ? [] : [scope.scopeDepartmentId];
  }
  return scope.scopeType === 'OWN_DEPARTMENTS' ? [...ownDepartmentIds] : [];
}

/** Raízes de subárvore que a verificação precisa ler (só atribuições com subárvore). */
export function competenceSubtreeRoots(
  scope: AssignmentScope,
  ownDepartmentIds: readonly string[],
): string[] {
  return scope.includeSubtree ? scopeRoots(scope, ownDepartmentIds) : [];
}

/**
 * Cobertura de uma atribuição vista por quem a detém (US-056 · "Aprovações pendentes"): o inverso
 * de `scopeCoversRequestingUnits` — o processo está coberto se `tenantWide`, se é do órgão
 * `organizationId` ou se a secretaria/setor solicitante está em `departmentIds` (expandidas).
 */
export interface RoleCompetence {
  readonly roleId: string;
  readonly tenantWide: boolean;
  readonly organizationId: string | null;
  readonly departmentIds: readonly string[];
}

export function competenceOf(
  assignment: AssignmentScope & { readonly roleId: string },
  holder: HolderUnits,
): RoleCompetence {
  const departmentIds =
    assignment.scopeType === 'DEPARTMENT' || assignment.scopeType === 'OWN_DEPARTMENTS'
      ? [
          ...new Set(
            scopeRoots(assignment, holder.ownDepartmentIds).flatMap((id) =>
              assignment.includeSubtree ? (holder.subtrees.get(id) ?? [id]) : [id],
            ),
          ),
        ].sort()
      : [];
  return {
    roleId: assignment.roleId,
    tenantWide: assignment.scopeType === 'TENANT',
    organizationId: assignment.scopeType === 'ORGANIZATION' ? assignment.scopeOrganizationId : null,
    departmentIds,
  };
}

/** A atribuição dá competência sobre as unidades solicitantes do processo (DEC-022)? */
export function scopeCoversRequestingUnits(
  scope: AssignmentScope,
  target: RequestingUnits,
  holder: HolderUnits,
): boolean {
  switch (scope.scopeType) {
    case 'TENANT':
      return true;
    case 'ORGANIZATION':
      return scope.scopeOrganizationId === target.organizationId;
    case 'DEPARTMENT':
    case 'OWN_DEPARTMENTS': {
      const covered = new Set(
        scopeRoots(scope, holder.ownDepartmentIds).flatMap((id) =>
          scope.includeSubtree ? (holder.subtrees.get(id) ?? [id]) : [id],
        ),
      );
      return target.departmentIds.some((id) => covered.has(id));
    }
  }
}
