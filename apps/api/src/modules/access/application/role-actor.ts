import type { PermissionCode } from '@contrataflow/types';
import { PROTECTED_ROLE_KEY } from '@contrataflow/validation';
import { Injectable } from '@nestjs/common';

import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { EffectivePermissionsService } from './effective-permissions.service.js';
import { PERMISSION_RISKS } from '../domain/permission-grants.js';
import type { ActorGrants } from '../domain/role-management.js';

/**
 * Permissões do ator na gestão de perfis (US-095 · POL-13 · RN-IAM-81): as permissões efetivas da
 * requisição (US-097 · DEC-134) em qualquer escopo — o retrato que o `AuthorizationGuard` pôs no
 * contexto, o mesmo de ROL-01 e ME-03, que une as atribuições vigentes de perfis ativos e, só sem
 * nenhuma atribuição gravada, a ponte das chaves do vínculo. Fora do pipeline HTTP (sem retrato no
 * contexto), calculadas no `tx` do chamador. Isento do anti-escalonamento: quem detém `ADMIN_ORGAO`
 * com escopo `TENANT` numa atribuição que concede agora (ou pela ponte).
 *
 * As chaves do vínculo não decidem sozinhas: o vínculo lido do PostgreSQL não as traz (spec-530).
 */
@Injectable()
export class RoleActorResolver {
  constructor(private readonly effective: EffectivePermissionsService) {}

  async resolve(tx: TenantTx): Promise<ActorGrants> {
    const context = requireRequestContext();
    const { membershipId, userId } = context.actor;
    if (membershipId === null || userId === null) {
      return { permissions: new Set(), isTenantAdmin: false };
    }
    const subject = { membershipId, userId, roleKeys: context.roleKeys ?? [] };
    const snapshot = context.permissions ?? (await this.effective.computeFor(tx, subject));
    return {
      permissions: new Set<PermissionCode>(snapshot.grants.flatMap((grant) => grant.permissions)),
      isTenantAdmin: await this.effective.holdsTenantWideRole(tx, subject, PROTECTED_ROLE_KEY),
    };
  }
}

/**
 * Exige a permissão do ator (RN-IAM-79 · RN-AUD-10: a recusa vira `access.denied` com a permissão
 * em `reasonCode`) e, para risco alto, o segundo fator quando `security.mfaPolicy` ≠ `NONE`
 * (POL-14). A permissão vem antes do MFA, como em `AccessFacade.assertCan`.
 */
export function authorizeActor(
  actor: Pick<ActorGrants, 'permissions'>,
  permission: PermissionCode,
  mfaPolicy: MfaPolicy,
  detail = 'Você não tem permissão para gerenciar perfis.',
): void {
  if (!actor.permissions.has(permission)) {
    throw new ApiError('PERMISSION_DENIED', {
      detail,
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
