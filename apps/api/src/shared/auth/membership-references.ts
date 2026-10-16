import type { PermissionCode } from '@contrataflow/types';
import { Injectable, Module } from '@nestjs/common';

import type { MfaPolicy } from './mfa-policy.js';
import type { TenantTx } from '../database/prisma.js';
import { ApiError } from '../errors/api-error.js';

/*
 * Referências do convite de usuário (US-091 · RN-IAM-46/51 · DEC-040/041). Os casos de uso de
 * vínculo são do `identity`, mas exigem a permissão do ator e o perfil inicial (`access`) e as
 * unidades da lotação (`organization`) — módulos do mesmo nível que já importam a fachada de
 * `identity`. A dependência no sentido contrário vira esta porta do shared kernel: `access` e
 * `organization` implementam e registram no `onModuleInit` (mesmo arranjo do
 * `DocumentTypeCatalog`). Sem provedor registrado, tudo falha fechado.
 */

/** Unidade lida no `tx` do chamador (RLS do tenant): nome e situação. */
export interface DepartmentReference {
  readonly name: string;
  readonly isActive: boolean;
}

export interface DepartmentReferenceProvider {
  /** Unidades do tenant da transação entre `ids` (as de outro tenant não voltam). */
  departmentsByIds(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DepartmentReference>>;
}

/** Perfil do tenant da transação (convite com perfil inicial). */
export interface RoleReference {
  readonly key: string;
  readonly isActive: boolean;
  /** POL-15: o perfil pode ser atribuído a vínculo `EXTERNAL`. */
  readonly allowExternalAssignment: boolean;
}

export interface InitialRoleGrant {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly grantedById: string;
  readonly now: Date;
}

export interface AccessReferenceProvider {
  /** `AccessFacade.assertCan` (403 `PERMISSION_DENIED` · POL-14 → 403 `MFA_REQUIRED`). */
  assertCan(permission: PermissionCode, options: { readonly mfaPolicy: MfaPolicy }): void;
  /** `null` se o perfil não existe no tenant da transação. */
  roleById(tx: TenantTx, roleId: string): Promise<RoleReference | null>;
  /**
   * Grava o `RoleAssignment` inicial do vínculo (RN-IAM-51), no escopo padrão do perfil, no `tx`
   * do convite. Só produz efeito de acesso quando o vínculo estiver `ACTIVE`.
   */
  grantInitialRole(tx: TenantTx, grant: InitialRoleGrant): Promise<void>;
}

@Injectable()
export class MembershipReferences {
  private departments: DepartmentReferenceProvider | null = null;
  private access: AccessReferenceProvider | null = null;

  registerDepartments(provider: DepartmentReferenceProvider): void {
    this.departments = provider;
  }

  registerAccess(provider: AccessReferenceProvider): void {
    this.access = provider;
  }

  assertCan(permission: PermissionCode, options: { readonly mfaPolicy: MfaPolicy }): void {
    if (!this.access) throw new ApiError('PERMISSION_DENIED', { auditReasonCode: permission });
    this.access.assertCan(permission, options);
  }

  departmentsByIds(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, DepartmentReference>> {
    if (ids.length === 0 || !this.departments) return Promise.resolve(new Map());
    return this.departments.departmentsByIds(tx, ids);
  }

  roleById(tx: TenantTx, roleId: string): Promise<RoleReference | null> {
    return this.access ? this.access.roleById(tx, roleId) : Promise.resolve(null);
  }

  grantInitialRole(tx: TenantTx, grant: InitialRoleGrant): Promise<void> {
    if (!this.access) throw new Error('MembershipReferences sem o provedor do módulo access.');
    return this.access.grantInitialRole(tx, grant);
  }
}

/** Importado por `identity` (consumidor), `access` e `organization` (implementadores). */
@Module({ providers: [MembershipReferences], exports: [MembershipReferences] })
export class MembershipReferencesModule {}
