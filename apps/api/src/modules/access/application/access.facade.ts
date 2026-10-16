import type { PermissionCode } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import type { ProcessVisibilityScope } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { AuthorizationService } from './authorization.service.js';
import type { ConfidentialBudgetAccess } from './authorization.service.js';
import { ROLE_REPOSITORY } from './ports.js';
import type { RoleRepository } from './ports.js';
import { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import type { SeedDefaultRolesResult } from './seed-default-roles.handler.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';
import { EffectivePermissionSet } from '../domain/effective-permissions.js';
import { PERMISSION_RISKS, rolesGrant } from '../domain/permission-grants.js';
import type { Role } from '../domain/role.js';

export type { ConfidentialBudgetAccess } from './authorization.service.js';

/** Perfis padrão atribuídos com escopo `TENANT` (permissions.md §3.1). */
const TENANT_WIDE_ROLE_KEYS: ReadonlySet<string> = new Set(
  DEFAULT_ROLES.filter((role) => role.defaultAssignmentScope === 'TENANT').map((role) => role.key),
);

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
  constructor(
    private readonly defaultRoles: SeedDefaultRolesHandler,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    private readonly authorization: AuthorizationService,
  ) {}

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
   * Exige a permissão (em algum escopo) para o vínculo da requisição (RN-AUD-10: a recusa vira
   * `access.denied` com a permissão em `reasonCode`) e, para permissão de risco alto, o segundo
   * fator quando `security.mfaPolicy` ≠ `NONE` (POL-14 → 403 `MFA_REQUIRED`). A permissão vem antes
   * do MFA: quem não pode a ação não é convidado a confirmar a identidade. Decide pelas permissões
   * efetivas que o `AuthorizationGuard` pôs no contexto (US-097); fora dele (casos de uso chamados
   * sem o pipeline HTTP), pela ponte das chaves do contexto contra a matriz padrão.
   */
  assertCan(permission: PermissionCode, options: { readonly mfaPolicy: MfaPolicy }): void {
    const context = requireRequestContext();
    if (!this.can(permission)) {
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

  /**
   * O vínculo da requisição tem a permissão em algum escopo (sem MFA nem auditoria) — ações
   * exibidas na tela e decisões que não negam a requisição.
   */
  can(permission: PermissionCode): boolean {
    const context = requireRequestContext();
    if (context.permissions) return new EffectivePermissionSet(context.permissions).has(permission);
    return rolesGrant(context.roleKeys ?? [], permission);
  }

  /**
   * Como `assertCan`, mas a permissão precisa cobrir a unidade (permissions.md §1.1 — ex.: unidade
   * solicitante do `PROCESS_CREATE`): `TENANT`, o órgão da unidade ou escopo de unidade que a
   * contenha (lotação, no `OWN_DEPARTMENTS`).
   */
  async assertCanInDepartment(
    permission: PermissionCode,
    department: { readonly id: string; readonly organizationId: string | null },
    options: { readonly mfaPolicy: MfaPolicy },
  ): Promise<void> {
    const permissions = await this.authorization.current();
    if (!permissions.coversDepartment(permission, department)) {
      throw new ApiError('PERMISSION_DENIED', { auditReasonCode: permission });
    }
    this.assertCan(permission, options);
  }

  /** Permissões efetivas do vínculo da requisição (contexto, cache ou banco — US-097). */
  effectivePermissions(): Promise<EffectivePermissionSet> {
    return this.authorization.current();
  }

  /**
   * Escopo de visibilidade de processos do usuário (DEC-024): entrada de
   * `buildVisibilityPredicate` (listagens) e de `isProcessVisible` (consulta por id).
   */
  async processVisibilityScope(): Promise<ProcessVisibilityScope> {
    return (await this.authorization.current()).visibilityScope();
  }

  /**
   * Desmascaramento do valor estimado sigiloso por linha nas listas de processos (POL-09 ·
   * RN-PROC-25 · FA-12 da US-002): escopos de `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (vazios sem o MFA
   * exigido) e as lotações para a custódia.
   */
  confidentialBudgetAccess(): Promise<ConfidentialBudgetAccess> {
    return this.authorization.confidentialBudgetAccess();
  }

  /** Algum dos perfis (`Role.key`) concede a permissão — vínculos de terceiros (aprovadores). */
  rolesGrant(roleKeys: readonly string[], permission: PermissionCode): boolean {
    return rolesGrant(roleKeys, permission);
  }

  /**
   * Algum dos perfis tem escopo sobre TODAS as unidades do tenant (US-102 · RN-TEN-48: titular e
   * substituto sem lotação na unidade). PONTE até as atribuições com escopo (US-096): hoje o escopo
   * é o padrão do perfil (`defaultAssignmentScope = TENANT`); a US-096 troca pela atribuição real
   * (`DEPARTMENT`/`OWN_DEPARTMENTS`/`ORGANIZATION`/`TENANT` que cubra a unidade) sem mudar quem chama.
   */
  rolesCoverAllDepartments(roleKeys: readonly string[]): boolean {
    return roleKeys.some((roleKey) => TENANT_WIDE_ROLE_KEYS.has(roleKey));
  }

  /**
   * Perfil do tenant da transação designável como aprovador (US-061 · RN-DOC-07 · RN-WF-16), ou
   * `null` se não existir nele (outro tenant = inexistente). `canDecideApprovals` vem das concessões
   * gravadas (`APPROVAL_DECIDE` — a matriz é editável desde a US-095).
   */
  async findRoleForApproval(tx: TenantTx, roleId: string): Promise<RoleForApproval | null> {
    const role = await this.roles.findById(tx, roleId);
    return role === null ? null : this.forApproval(tx, role);
  }

  /** Perfil pela chave estável (`AUTORIDADE_COMPETENTE`…) — seeders de outros módulos (US-042). */
  async findRoleByKey(tx: TenantTx, key: string): Promise<RoleForApproval | null> {
    const [role] = await this.roles.findByKeys(tx, [key]);
    return role === undefined ? null : this.forApproval(tx, role);
  }

  private async forApproval(tx: TenantTx, role: Role): Promise<RoleForApproval> {
    const permissions = await this.roles.permissionsOf(tx, role.id);
    return {
      id: role.id,
      isActive: role.isActive,
      canDecideApprovals: permissions.includes('APPROVAL_DECIDE'),
    };
  }
}
