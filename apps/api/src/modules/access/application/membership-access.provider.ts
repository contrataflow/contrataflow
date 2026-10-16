import type { PermissionCode } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import type {
  AccessReferenceProvider,
  InitialRoleGrant,
  RoleReference,
} from '#shared/auth/membership-references.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AccessFacade } from './access.facade.js';
import { ROLE_ASSIGNMENT_REPOSITORY, ROLE_REPOSITORY } from './ports.js';
import type { RoleAssignmentRepository, RoleRepository } from './ports.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';
import type { ScopeType } from '../domain/role.js';

/** POL-12: o perfil que o tenant nunca pode perder (permissions.md §4). */
const ADMIN_ROLE_KEY = 'ADMIN_ORGAO';

/** Escopo padrão por perfil padrão (permissions.md §3.1). */
const DEFAULT_SCOPES: ReadonlyMap<string, ScopeType> = new Map(
  DEFAULT_ROLES.map((role) => [role.key, role.defaultAssignmentScope]),
);

/**
 * Lado `access` da porta `MembershipReferences` (US-091): a autorização do ator (`assertCan`, com
 * MFA conforme `security.mfaPolicy` — POL-14), o perfil do convite e o `RoleAssignment` inicial
 * (RN-IAM-51). O escopo é o padrão do perfil (§3.1); perfil personalizado, que não tem padrão,
 * fica com `TENANT` — o administrador ajusta escopo e vigência na gestão de atribuições (US-096).
 */
@Injectable()
export class MembershipAccessProvider implements AccessReferenceProvider {
  constructor(
    private readonly access: AccessFacade,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly assignments: RoleAssignmentRepository,
  ) {}

  assertCan(permission: PermissionCode, options: { readonly mfaPolicy: MfaPolicy }): void {
    this.access.assertCan(permission, options);
  }

  hasPermission(permission: PermissionCode): boolean {
    return this.access.can(permission);
  }

  async roleById(tx: TenantTx, roleId: string): Promise<RoleReference | null> {
    const role = await this.roles.findById(tx, roleId);
    return role
      ? {
          key: role.key,
          isActive: role.isActive,
          allowExternalAssignment: role.allowExternalAssignment,
        }
      : null;
  }

  /** POL-12 (US-092): vínculos com o `ADMIN_ORGAO` vigente — o identity confere status e trava. */
  async adminMembershipIds(tx: TenantTx, now: Date): Promise<ReadonlySet<string>> {
    const [admin] = await this.roles.findByKeys(tx, [ADMIN_ROLE_KEY]);
    if (!admin?.isActive) return new Set();
    return new Set(await this.assignments.membershipIdsWithRole(tx, admin.id, now));
  }

  async grantInitialRole(tx: TenantTx, grant: InitialRoleGrant): Promise<void> {
    const role = await this.roles.findById(tx, grant.roleId);
    if (!role) throw new Error('Perfil do convite não encontrado no tenant.');
    await this.assignments.insertInitial(tx, {
      ...grant,
      scopeType: DEFAULT_SCOPES.get(role.key) ?? 'TENANT',
    });
  }
}
