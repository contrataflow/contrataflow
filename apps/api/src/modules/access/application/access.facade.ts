import type { PermissionCode } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import type { SeedDefaultRolesResult } from './seed-default-roles.handler.js';
import { PERMISSION_RISKS, rolesGrant } from '../domain/permission-grants.js';

/** Perfil visto por quem valida designações (US-061 · RN-DOC-07). */
export interface RoleForApproval {
  readonly id: string;
  readonly isActive: boolean;
  /** O perfil contém `APPROVAL_DECIDE`. */
  readonly canDecideApprovals: boolean;
}

/**
 * API pública do módulo `access` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class AccessFacade {
  constructor(private readonly defaultRoles: SeedDefaultRolesHandler) {}

  /**
   * Seeder `access.defaultRoles` (US-094 · RN-IAM-74..77) para o checklist de provisionamento
   * (US-099): os 15 perfis padrão e a matriz de permissões no tenant do contexto, dentro do `tx`
   * do item do checklist (falha desfaz tudo), idempotente na reexecução. O contexto deve ser do
   * ator `SYSTEM` (`runAsSystem`) — a auditoria `role.create` herda o ator.
   */
  seedDefaultRoles(tx: TenantTx): Promise<SeedDefaultRolesResult> {
    return this.defaultRoles.execute(tx);
  }

  /**
   * Exige a permissão para o vínculo da requisição (RN-AUD-10: a recusa vira `access.denied` com
   * a permissão em `reasonCode`) e, para permissão de risco alto, o segundo fator quando
   * `security.mfaPolicy` ≠ `NONE` (POL-14 → 403 `MFA_REQUIRED`). A permissão vem antes do MFA:
   * quem não pode a ação não é convidado a confirmar a identidade.
   */
  assertCan(permission: PermissionCode, options: { readonly mfaPolicy: MfaPolicy }): void {
    const context = requireRequestContext();
    if (!rolesGrant(context.roleKeys ?? [], permission)) {
      throw new ApiError('PERMISSION_DENIED', { auditReasonCode: permission });
    }
    if (
      PERMISSION_RISKS[permission] === 'HIGH' &&
      options.mfaPolicy !== 'NONE' &&
      !hasSecondFactor(context.amr)
    ) {
      throw new ApiError('MFA_REQUIRED', { auditReasonCode: 'MFA_REQUIRED' });
    }
  }

  /** Algum dos perfis (`Role.key`) concede a permissão — vínculos de terceiros (aprovadores). */
  rolesGrant(roleKeys: readonly string[], permission: PermissionCode): boolean {
    return rolesGrant(roleKeys, permission);
  }

  /**
   * Perfil do tenant da transação, ou `null` se não existir nele. A tabela `roles` existe desde a
   * US-094, mas a designação de perfis como aprovadores chega com a US-095/US-096; até lá a
   * consulta devolve `null`.
   */
  findRoleForApproval(_tx: TenantTx, _roleId: string): Promise<RoleForApproval | null> {
    return Promise.resolve(null);
  }
}
