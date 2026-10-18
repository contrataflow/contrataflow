import type { PermissionCode } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import type { MfaPolicy } from '#shared/auth/mfa-policy.js';
import { isProcessVisible } from '#shared/auth/process-access.js';
import type { ProcessAccessTarget, ProcessVisibilityScope } from '#shared/auth/process-access.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError } from '#shared/errors/api-error.js';

import { ApprovalCompetenceService } from './approval-competence.service.js';
import { AuthorizationService } from './authorization.service.js';
import type { ConfidentialBudgetAccess } from './authorization.service.js';
import { EffectivePermissionsService } from './effective-permissions.service.js';
import { ROLE_REPOSITORY } from './ports.js';
import type { RoleRepository } from './ports.js';
import { SeedDefaultRolesHandler } from './seed-default-roles.handler.js';
import type { SeedDefaultRolesResult } from './seed-default-roles.handler.js';
import type { RequestingUnits } from '../domain/approval-competence.js';
import { DEFAULT_ROLES } from '../domain/default-roles.js';
import { EffectivePermissionSet } from '../domain/effective-permissions.js';
import { PERMISSION_RISKS, rolesGrant } from '../domain/permission-grants.js';
import type { Role } from '../domain/role.js';

export type { ConfidentialBudgetAccess } from './authorization.service.js';
export type { RequestingUnits } from '../domain/approval-competence.js';

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
    private readonly effective: EffectivePermissionsService,
    private readonly competence: ApprovalCompetenceService,
  ) {}

  /**
   * Detentores do perfil competentes para aprovar sobre as unidades solicitantes do processo
   * (US-051 · RN-TRAM-47 · DEC-022): atribuições vigentes `TENANT`, `ORGANIZATION` do processo ou
   * `DEPARTMENT`/`OWN_DEPARTMENTS` contendo a secretaria/setor solicitante, de vínculos ativos —
   * nunca concessões `CURRENT`/`HISTORICAL`. No `tx` do chamador; vazio = ninguém no escopo.
   */
  roleHoldersInScopeIn(
    tx: TenantTx,
    roleId: string,
    target: RequestingUnits,
    now: Date,
  ): Promise<string[]> {
    return this.competence.roleHolders(tx, roleId, target, now);
  }

  /**
   * O vínculo de um TERCEIRO tem a permissão em algum escopo vigente (US-047 · RN-TRAM-08: o
   * destinatário do encaminhamento precisa de `PROCESS_VIEW`). Calculado no `tx` do chamador.
   */
  async membershipHoldsIn(
    tx: TenantTx,
    member: {
      readonly membershipId: string;
      readonly userId: string;
      readonly roleKeys: readonly string[];
    },
    permission: PermissionCode,
  ): Promise<boolean> {
    const snapshot = await this.effective.computeFor(tx, member);
    return snapshot.grants.some((grant) => grant.permissions.includes(permission));
  }

  /**
   * O vínculo de um TERCEIRO vê o processo (DEC-024 · US-072 · RN-CMT-21/22: candidatos e alvos de
   * menção): concessão própria (`ProcessAccess` do usuário) ou o predicado de visibilidade sobre os
   * escopos de `PROCESS_VIEW` dele, calculados no `tx` do chamador (sem cache).
   */
  async memberCanViewProcess(
    tx: TenantTx,
    member: {
      readonly membershipId: string;
      readonly userId: string;
      readonly roleKeys: readonly string[];
    },
    process: ProcessAccessTarget,
  ): Promise<boolean> {
    if (process.userIds.includes(member.userId)) return true;
    const snapshot = await this.effective.computeFor(tx, member);
    return isProcessVisible(new EffectivePermissionSet(snapshot).visibilityScope(), process);
  }

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
    options: { readonly mfaPolicy: MfaPolicy; readonly detail?: string },
  ): Promise<void> {
    const permissions = await this.authorization.current();
    if (!permissions.coversDepartment(permission, department)) {
      throw new ApiError('PERMISSION_DENIED', {
        auditReasonCode: permission,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
      });
    }
    this.assertCan(permission, options);
  }

  /**
   * Como `assertCan`, mas a permissão precisa cobrir o PROCESSO (perfil com escopo que o cubra ∪
   * participação — permissions.md §1.1/§4), com MFA (POL-14) e a recusa auditada como
   * `access.denied` — para recursos cujo processo vem do próprio recurso (documento — US-065) e não
   * do caminho da rota.
   */
  async assertCanOnProcess(
    permission: PermissionCode,
    process: ProcessAccessTarget,
    detail?: string,
  ): Promise<void> {
    const permissions = await this.authorization.current();
    await this.authorization.assertPermission(permissions, permission, process, detail);
  }

  /** A permissão cobre o processo (perfil ∪ participação), sem MFA nem auditoria — ações exibidas. */
  async canOnProcess(permission: PermissionCode, process: ProcessAccessTarget): Promise<boolean> {
    const permissions = await this.authorization.current();
    return (
      permissions.roleCoversProcess(permission, process) ||
      permissions.participationGrants(permission, process, new Date())
    );
  }

  /**
   * A permissão libera um campo sensível da resposta (US-054: `ip` com `AUDIT_VIEW`) — sem negar
   * nem auditar; `HIGH` sem o 2º fator exigido não conta.
   */
  revealsField(permission: PermissionCode): Promise<boolean> {
    return this.authorization.revealsField(permission);
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

  /**
   * Chave e nome dos perfis do tenant da transação (US-004: aprovador designado por perfil no
   * painel situacional). Perfil inexistente no tenant fica de fora.
   */
  async roleSummaries(
    tx: TenantTx,
    roleIds: readonly string[],
  ): Promise<Map<string, { readonly key: string; readonly name: string }>> {
    const summaries = new Map<string, { readonly key: string; readonly name: string }>();
    for (const id of new Set(roleIds)) {
      const role = await this.roles.findById(tx, id);
      if (role !== null) summaries.set(id, { key: role.key, name: role.name });
    }
    return summaries;
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
