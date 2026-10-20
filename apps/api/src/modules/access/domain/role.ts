import { isPermissionCode } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';

/*
 * Perfil (`Role`) e concessão (`RolePermission`) do módulo `access` (entities.md §4.2 · DEC-134):
 * perfis são do tenant; as permissões vêm do catálogo global de `@contrataflow/types`.
 */

/** Escopo de atribuição (entities.md §2 `ScopeType` · permissions.md §1). */
export type ScopeType = 'TENANT' | 'ORGANIZATION' | 'DEPARTMENT' | 'OWN_DEPARTMENTS';

export interface Role {
  readonly id: string;
  readonly tenantId: string;
  /** SCREAMING_SNAKE, imutável. */
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** Semeado no provisionamento; não pode ser excluído. */
  readonly isSystem: boolean;
  /** `ADMIN_ORGAO`: permissões de administração não removíveis (DEC-035). */
  readonly isProtected: boolean;
  /** Pode ser atribuído a vínculos `EXTERNAL` (POL-15). */
  readonly allowExternalAssignment: boolean;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface RolePermission {
  readonly id: string;
  readonly tenantId: string;
  readonly roleId: string;
  readonly permissionCode: PermissionCode;
  readonly createdAt: Date;
  readonly createdById: string | null;
}

/** Concessão a um código fora do catálogo (V-02): falha de implantação, nunca do usuário. */
export class UnknownPermissionError extends Error {
  readonly code = 'REFERENCE_NOT_FOUND';

  constructor(
    readonly roleKey: string,
    readonly permissionCode: string,
  ) {
    super(`Perfil ${roleKey} referencia a permissão inexistente ${permissionCode}.`);
    this.name = 'UnknownPermissionError';
  }
}

/** `RolePermission.grant` — concede uma permissão do catálogo ao perfil (V-02 para código ausente). */
export function grantPermission(
  role: Pick<Role, 'id' | 'tenantId' | 'key'>,
  permissionCode: string,
  data: { readonly id: string; readonly now: Date; readonly userId: string | null },
): RolePermission {
  if (!isPermissionCode(permissionCode)) {
    throw new UnknownPermissionError(role.key, permissionCode);
  }
  return {
    id: data.id,
    tenantId: role.tenantId,
    roleId: role.id,
    permissionCode,
    createdAt: data.now,
    createdById: data.userId,
  };
}
