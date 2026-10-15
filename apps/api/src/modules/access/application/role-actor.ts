import type { PermissionCode } from '@contrataflow/types';
import { PROTECTED_ROLE_KEY } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ROLE_REPOSITORY } from './ports.js';
import type { RoleRepository } from './ports.js';
import { DEFAULT_ROLE_GRANTS } from '../domain/default-roles.js';
import { PERMISSION_RISKS } from '../domain/permission-grants.js';
import type { ActorGrants } from '../domain/role-management.js';

const DEFAULT_GRANTS: Readonly<Record<string, readonly PermissionCode[] | undefined>> =
  DEFAULT_ROLE_GRANTS;

/**
 * Permissões efetivas do ator na gestão de perfis (US-095 · POL-13 · RN-IAM-81): a união das
 * concessões ATUAIS dos perfis do tenant cujas chaves estão no vínculo (`roleKeys` do contexto) —
 * perfil inativo não concede nada (RN-IAM-84). Chave sem perfil no tenant (tenant ainda não semeado,
 * modo fake) cai na matriz padrão, como `AccessFacade.assertCan`.
 *
 * PONTE até a US-097: ela troca esta leitura pelo `AuthorizationService` (escopos, vigência e cache
 * de 5 min); a resolução por chave já reflete as matrizes editadas aqui, o que o `assertCan` dos
 * demais módulos (matriz padrão) ainda não faz.
 */
@Injectable()
export class RoleActorResolver {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository) {}

  async resolve(tx: TenantTx): Promise<ActorGrants> {
    const keys = requireRequestContext().roleKeys ?? [];
    const tenantRoles = new Map(
      (await this.roles.grantsByKeys(tx, keys)).map((role) => [role.key, role]),
    );
    const permissions = new Set<PermissionCode>();
    let isTenantAdmin = false;
    for (const key of keys) {
      const role = tenantRoles.get(key);
      const active = role?.isActive ?? true;
      if (key === PROTECTED_ROLE_KEY && active) isTenantAdmin = true;
      const granted = role ? (role.isActive ? role.permissions : []) : (DEFAULT_GRANTS[key] ?? []);
      for (const code of granted) permissions.add(code);
    }
    return { permissions, isTenantAdmin };
  }
}

/**
 * Exige a permissão do ator (RN-IAM-79 · RN-AUD-10: a recusa vira `access.denied` com a permissão
 * em `reasonCode`) e, para risco alto, o segundo fator quando `security.mfaPolicy` ≠ `NONE`
 * (POL-14). A permissão vem antes do MFA, como em `AccessFacade.assertCan`.
 */
export function authorizeActor(
  actor: ActorGrants,
  permission: PermissionCode,
  mfaPolicy: MfaPolicy,
): void {
  if (!actor.permissions.has(permission)) {
    throw new ApiError('PERMISSION_DENIED', {
      detail: 'Você não tem permissão para gerenciar perfis.',
      auditReasonCode: permission,
    });
  }
  if (
    PERMISSION_RISKS[permission] === 'HIGH' &&
    mfaPolicy !== 'NONE' &&
    !hasSecondFactor(requireRequestContext().amr)
  ) {
    throw new ApiError('MFA_REQUIRED', { auditReasonCode: 'MFA_REQUIRED' });
  }
}
