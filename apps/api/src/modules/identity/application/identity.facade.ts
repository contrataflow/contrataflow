import { Inject, Injectable } from '@nestjs/common';

import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { MembershipStatus } from '#shared/auth/ports.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { MEMBERSHIP_REPOSITORY } from './membership-ports.js';
import type { MembershipRepository } from './membership-ports.js';
import { IDENTITY_REPOSITORY, TENANT_MFA_POLICY } from './ports.js';
import type {
  ActiveMemberMatch,
  IdentityRepository,
  TenantMember,
  TenantMfaPolicyPort,
} from './ports.js';
import type { MembershipType } from '../domain/tenant-membership.js';

export type { ActiveMemberMatch, TenantMember } from './ports.js';

/** Vínculo de destino de uma atribuição de perfil (US-096 · RN-IAM-90/92/93). */
export interface MembershipForAssignment {
  readonly id: string;
  readonly userId: string;
  readonly type: MembershipType;
  readonly status: MembershipStatus;
  readonly expiresAt: Date | null;
}

/**
 * API pública do módulo `identity` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class IdentityFacade {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityRepository,
    @Inject(TENANT_MFA_POLICY) private readonly mfaPolicies: TenantMfaPolicyPort,
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * Vínculo do usuário no tenant da transação (US-096: ROL-10/11), ou `null` se o usuário não tem
   * vínculo nele — vínculo de outro tenant não é revelado (RLS).
   */
  async membershipOfUser(tx: TenantTx, userId: string): Promise<MembershipForAssignment | null> {
    const state = await this.memberships.findStateByUser(tx, userId);
    return state
      ? {
          id: state.id,
          userId: state.userId,
          type: state.type,
          status: state.status,
          expiresAt: state.expiresAt,
        }
      : null;
  }

  /** Usuário de cada vínculo do tenant da transação (US-096: quem tem o perfil — ROL-09). */
  membershipUserIds(tx: TenantTx, membershipIds: readonly string[]): Promise<Map<string, string>> {
    return this.memberships.userIdsOf(tx, membershipIds);
  }

  /**
   * POL-12 (US-096 · ROL-12): entre `membershipIds`, os vínculos `ACTIVE` e não vencidos, travados
   * (`FOR UPDATE`, em ordem de id) até o fim da transação — duas revogações simultâneas do
   * `ADMIN_ORGAO` não passam as duas.
   */
  lockActiveMemberships(
    tx: TenantTx,
    membershipIds: readonly string[],
    now: Date,
  ): Promise<string[]> {
    return this.memberships.lockActiveMemberships(tx, membershipIds, now);
  }

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

  /**
   * Membros ativos por nome/nome social/e-mail (US-072 · CMT-05 — autocomplete de menções), no
   * tenant da transação.
   */
  searchActiveMembers(
    tx: TenantTx,
    q: string,
    limit: number,
    now: Date,
  ): Promise<ActiveMemberMatch[]> {
    return this.identity.searchActiveMembers(tx, q, limit, now);
  }

  /** Membros ativos lotados em cada unidade (US-072 · FA-04: unidade com mais de 50 fica de fora). */
  activeMemberCounts(
    tx: TenantTx,
    departmentIds: readonly string[],
    now: Date,
  ): Promise<Map<string, number>> {
    if (departmentIds.length === 0) return Promise.resolve(new Map<string, number>());
    return this.identity.activeMemberCounts(tx, departmentIds, now);
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

  /**
   * Descarta a `security.mfaPolicy` em cache do tenant do contexto logo após o commit do SET-02
   * (RN-IAM-42): a próxima requisição já é avaliada pela nova política.
   */
  invalidateMfaPolicy(): Promise<void> {
    return this.mfaPolicies.invalidate();
  }
}
