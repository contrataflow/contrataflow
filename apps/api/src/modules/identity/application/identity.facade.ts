import { Inject, Injectable } from '@nestjs/common';

import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { IDENTITY_REPOSITORY, TENANT_MFA_POLICY } from './ports.js';
import type { IdentityRepository, TenantMember, TenantMfaPolicyPort } from './ports.js';

export type { TenantMember } from './ports.js';

/**
 * API pública do módulo `identity` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class IdentityFacade {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
    @Inject(TENANT_MFA_POLICY) private readonly mfaPolicies: TenantMfaPolicyPort,
  ) {}

  /**
   * Nome exibido (social, se houver) dos usuários com vínculo no tenant da transação, lidos no `tx`
   * do caso de uso — os nomes congelados da timeline (US-059). Usuário fora do tenant não volta.
   */
  userDisplayNames(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>> {
    return this.identity.displayNamesInTenant(tx, userIds);
  }

  /**
   * Vínculos dos usuários no tenant da transação, em qualquer situação — quem não tem vínculo no
   * tenant não volta (US-061: validação de aprovador designado).
   */
  membersInTenant(tx: TenantTx, userIds: readonly string[]): Promise<TenantMember[]> {
    return this.identity.membersInTenant(tx, userIds);
  }

  /**
   * Usuários (entre `userIds`) lotados na unidade, no tenant da transação — elegibilidade de
   * titular/substituto (US-102 · RN-TEN-48).
   */
  usersAssignedToDepartment(
    tx: TenantTx,
    departmentId: string,
    userIds: readonly string[],
  ): Promise<Set<string>> {
    if (userIds.length === 0) return Promise.resolve(new Set());
    return this.identity.usersAssignedToDepartment(tx, departmentId, userIds);
  }

  /**
   * Unidades em que o usuário é lotado pelo vínculo ativo no tenant da transação (US-041: custódia
   * e visibilidade de processos por unidade).
   */
  departmentsOfUser(tx: TenantTx, userId: string): Promise<string[]> {
    return this.identity.departmentsOfUser(tx, userId);
  }

  /** A unidade tem lotações? (impede a exclusão física — US-102 · RN-TEN-51). */
  async hasDepartmentAssignments(tx: TenantTx, departmentId: string): Promise<boolean> {
    return (await this.identity.countDepartmentAssignments(tx, departmentId)) > 0;
  }

  /** `security.mfaPolicy` do tenant da requisição (POL-14). */
  mfaPolicy(): Promise<MfaPolicy> {
    const { tenantId } = requireRequestContext();
    if (tenantId === null) throw new Error('mfaPolicy exige o tenant do contexto.');
    return this.mfaPolicies.mfaPolicyOf(tenantId);
  }
}
