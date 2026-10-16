import type { PermissionCode } from '@contrataflow/types';
import {
  PROTECTED_ROLE_KEY,
  ROLE_ASSIGNMENT_DUPLICATE_MESSAGE,
  ROLE_ASSIGNMENT_ESCALATION_MESSAGE,
  ROLE_ASSIGNMENT_EXTERNAL_MESSAGE,
  ROLE_ASSIGNMENT_LAST_ADMIN_MESSAGE,
  ROLE_ASSIGNMENT_MEMBERSHIP_INACTIVE_MESSAGE,
  ROLE_ASSIGNMENT_SELF_PROTECTION_MESSAGE,
  RoleAssigned,
  RoleRevoked,
} from '@contrataflow/validation';
import type {
  AssignRole,
  FieldError,
  RoleAssignmentDto,
  RoleAssignmentListMeta,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import type { DepartmentReference } from '#shared/auth/membership-references.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  RoleAssignmentAlreadyExistsError,
} from './ports.js';
import type {
  AccessClock,
  AccessTransactions,
  RoleAssignmentRepository,
  RoleRepository,
} from './ports.js';
import { authorizeActor, RoleActorResolver } from './role-actor.js';
import { roleNotFound } from './role.errors.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import type { MembershipForAssignment } from '../../identity/application/identity.facade.js';
import {
  AssignmentAlreadyRevokedError,
  AssignmentValidationError,
  escalatedPermissions,
  externalAssignmentForbidden,
  grantRoleAssignment,
  isAdministrativeRole,
  isEffective,
  revokeRoleAssignment,
  TENANT_SCOPE,
  violatesSelfProtection,
} from '../domain/role-assignment.js';
import type { AssignmentActor, RoleAssignment, ScopedGrant } from '../domain/role-assignment.js';
import type { Role } from '../domain/role.js';

/** Ator da atribuição: permissões efetivas (`ROLE_ASSIGN`…) e os escopos de cada concessão. */
export interface ScopedActor extends AssignmentActor {
  readonly permissions: ReadonlySet<PermissionCode>;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function userNotFound(): ApiError {
  return new ApiError('USER_NOT_FOUND', { detail: 'Usuário não encontrado.' });
}

function assignmentNotFound(): ApiError {
  return new ApiError('ROLE_ASSIGNMENT_NOT_FOUND');
}

function versionConflict(): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Esta atribuição foi alterada por outra pessoa. Recarregue.',
  });
}

/** V-07 · RN-IAM-94. */
function duplicate(): ApiError {
  return new ApiError('ROLE_ASSIGNMENT_ALREADY_EXISTS', {
    detail: ROLE_ASSIGNMENT_DUPLICATE_MESSAGE,
  });
}

/** Falha inesperada ou 5xx (banco fora → `DEPENDENCY_UNAVAILABLE`); recusas 4xx não são falhas. */
function failureCode(error: unknown): string | null {
  if (error instanceof ApiError) return error.status >= 500 ? error.code : null;
  return 'INTERNAL_ERROR';
}

/**
 * Permissões e escopos do ator na atribuição de perfis (US-096 · POL-13): as atribuições VIGENTES
 * do vínculo da requisição, com as concessões ATUAIS de cada perfil ativo. PONTE até a US-097: sem
 * nenhuma atribuição gravada (vínculo ainda sem `role_assignments`, modo fake), valem as chaves do
 * contexto (`RoleActorResolver`) com escopo `TENANT`, como no restante do `access`.
 */
@Injectable()
export class AssignmentActorResolver {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly assignments: RoleAssignmentRepository,
    private readonly byKeys: RoleActorResolver,
  ) {}

  async resolve(tx: TenantTx, now: Date): Promise<ScopedActor> {
    const membershipId = requireRequestContext().actor.membershipId;
    const own = membershipId
      ? (await this.assignments.listByMembership(tx, membershipId)).filter((item) =>
          isEffective(item, now),
        )
      : [];
    if (own.length === 0) {
      const fallback = await this.byKeys.resolve(tx);
      return {
        ...fallback,
        grants: [{ scope: TENANT_SCOPE, permissions: fallback.permissions }],
      };
    }
    const roles = new Map<string, { role: Role; permissions: ReadonlySet<PermissionCode> }>();
    for (const roleId of new Set(own.map((item) => item.roleId))) {
      const role = await this.roles.findById(tx, roleId);
      if (role?.isActive) {
        roles.set(roleId, {
          role,
          permissions: new Set(await this.roles.permissionsOf(tx, roleId)),
        });
      }
    }
    const grants: ScopedGrant[] = [];
    const permissions = new Set<PermissionCode>();
    let isTenantAdmin = false;
    for (const assignment of own) {
      const granted = roles.get(assignment.roleId);
      if (!granted) continue;
      grants.push({ scope: assignment, permissions: granted.permissions });
      for (const code of granted.permissions) permissions.add(code);
      if (granted.role.key === PROTECTED_ROLE_KEY && assignment.scopeType === 'TENANT') {
        isTenantAdmin = true;
      }
    }
    return { permissions, isTenantAdmin, grants };
  }
}

/**
 * Base de ROL-09..12 (US-096): transação com o `app.tenant_id` do contexto, ator com escopos,
 * resposta nomeada (perfil, escopo, quem concedeu, vínculo) e — depois do commit — a invalidação
 * imediata do cache de permissões efetivas do vínculo (RN-IAM-99: `DEL`; o
 * `PermissionCacheInvalidator` repete pelo evento; Redis fora não desfaz nada e a próxima leitura
 * recalcula pelo TTL de 5 min).
 */
@Injectable()
export class RoleAssignmentSupport {
  readonly logger = new Logger('RoleAssignments');

  constructor(
    @Inject(ROLE_REPOSITORY) readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) readonly assignments: RoleAssignmentRepository,
    @Inject(ACCESS_TRANSACTIONS) readonly transactions: AccessTransactions,
    @Inject(ACCESS_CLOCK) readonly clock: AccessClock,
    @Inject(AUDIT_TRAIL) readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) readonly outbox: OutboxWriterPort,
    readonly actors: AssignmentActorResolver,
    readonly identity: IdentityFacade,
    readonly references: MembershipReferences,
    private readonly cache: TenantCache,
  ) {}

  /** Executa a mutação; falha 5xx/inesperada → `error role.assignment_failed`. */
  async mutate<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const context = requireRequestContext();
    try {
      return await this.transactions.run(work);
    } catch (error) {
      const errorCode = failureCode(error);
      if (errorCode !== null) {
        this.logger.error(
          {
            event: 'role.assignment_failed',
            errorCode,
            cause: error instanceof Error ? error.name : 'unknown',
            correlationId: context.correlationId,
          },
          'role.assignment_failed',
        );
      }
      throw error;
    }
  }

  /** RN-IAM-99: `DEL cf:{env}:t:{tenantId}:access:eff:{membershipId}` já no commit. */
  async invalidatePermissions(membershipId: string): Promise<void> {
    try {
      await this.cache.delete('access', `eff:${membershipId}`);
    } catch (error) {
      this.logger.warn(
        {
          event: 'cache.invalidation_unavailable',
          membershipId,
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'cache.invalidation_unavailable',
      );
    }
  }

  logChange(event: 'role.assignment_created' | 'role.assignment_revoked', item: RoleAssignment) {
    this.logger.log(
      {
        event,
        roleAssignmentId: item.id,
        membershipId: item.membershipId,
        roleId: item.roleId,
        scopeType: item.scopeType,
        correlationId: requireRequestContext().correlationId,
      },
      event,
    );
  }

  async membershipOrNotFound(tx: TenantTx, userId: string): Promise<MembershipForAssignment> {
    const membership = await this.identity.membershipOfUser(tx, userId);
    if (!membership) throw userNotFound();
    return membership;
  }

  /** As atribuições como `RoleAssignment` da resposta, com nomes lidos no mesmo `tx`. */
  async toDtos(tx: TenantTx, items: readonly RoleAssignment[]): Promise<RoleAssignmentDto[]> {
    if (items.length === 0) return [];
    const roleIds = [...new Set(items.map((item) => item.roleId))];
    const roles = new Map<string, { role: Role | null; administrative: boolean }>();
    for (const roleId of roleIds) {
      const role = await this.roles.findById(tx, roleId);
      const administrative = role
        ? isAdministrativeRole(await this.roles.permissionsOf(tx, roleId))
        : false;
      roles.set(roleId, { role, administrative });
    }
    const membershipUsers = await this.identity.membershipUserIds(tx, [
      ...new Set(items.map((item) => item.membershipId)),
    ]);
    const userIds = new Set<string>([
      ...membershipUsers.values(),
      ...items.map((item) => item.grantedById),
    ]);
    const names = await this.identity.userDisplayNames(tx, [...userIds]);
    const organizations = await this.references.organizationsByIds(
      tx,
      items.flatMap((item) => (item.scopeOrganizationId ? [item.scopeOrganizationId] : [])),
    );
    const departments = await this.references.departmentsByIds(
      tx,
      items.flatMap((item) => (item.scopeDepartmentId ? [item.scopeDepartmentId] : [])),
    );
    return items.map((item) => {
      const role = roles.get(item.roleId);
      const userId = membershipUsers.get(item.membershipId) ?? '';
      const scopeName = item.scopeOrganizationId
        ? (organizations.get(item.scopeOrganizationId)?.name ?? null)
        : item.scopeDepartmentId
          ? (departments.get(item.scopeDepartmentId)?.name ?? null)
          : null;
      return {
        id: item.id,
        membershipId: item.membershipId,
        userId,
        userName: names.get(userId) ?? '',
        roleId: item.roleId,
        roleKey: role?.role?.key ?? '',
        roleName: role?.role?.name ?? '',
        isAdministrative: role?.administrative ?? false,
        scopeType: item.scopeType,
        scopeOrganizationId: item.scopeOrganizationId,
        scopeDepartmentId: item.scopeDepartmentId,
        scopeName,
        includeSubtree: item.includeSubtree,
        validFrom: item.validFrom.toISOString(),
        validUntil: iso(item.validUntil),
        status: item.revokedAt === null ? 'ACTIVE' : 'REVOKED',
        grantedBy: names.has(item.grantedById)
          ? { id: item.grantedById, name: names.get(item.grantedById) ?? '' }
          : null,
        grantedAt: item.createdAt.toISOString(),
        revokedAt: iso(item.revokedAt),
        version: item.version,
      };
    });
  }

  async toDto(tx: TenantTx, item: RoleAssignment): Promise<RoleAssignmentDto> {
    const [dto] = await this.toDtos(tx, [item]);
    if (!dto) throw new Error('Atribuição sem representação.');
    return dto;
  }
}

/** Resposta de ROL-10: a lista e `meta.canAssign`/`isSelf` (api.md §1.5). */
export interface UserRoleAssignmentsResult {
  readonly data: RoleAssignmentDto[];
  readonly meta: RoleAssignmentListMeta;
}

/**
 * `ListUserRoleAssignmentsQuery` — ROL-10 (`USER_VIEW` ou `ROLE_VIEW`): atribuições não revogadas
 * do vínculo do usuário no tenant (inclusive a do convite — FA-06). Usuário sem vínculo no tenant
 * (outro tenant) → 404 `USER_NOT_FOUND`, sem revelar nada.
 */
@Injectable()
export class ListUserRoleAssignmentsQuery {
  constructor(private readonly support: RoleAssignmentSupport) {}

  execute(userId: string): Promise<UserRoleAssignmentsResult> {
    const context = requireRequestContext();
    return this.support.transactions.read(async (tx) => {
      const actor = await this.support.actors.resolve(tx, this.support.clock());
      const permission = actor.permissions.has('USER_VIEW') ? 'USER_VIEW' : 'ROLE_VIEW';
      authorizeActor(actor, permission, 'NONE', 'Você não tem permissão para ver os perfis.');
      const membership = await this.support.membershipOrNotFound(tx, userId);
      const items = await this.support.assignments.listByMembership(tx, membership.id);
      return {
        data: await this.support.toDtos(tx, items),
        meta: {
          canAssign: actor.permissions.has('ROLE_ASSIGN'),
          isSelf: context.actor.membershipId === membership.id,
        },
      };
    });
  }
}

/** `ListRoleAssignmentsQuery` — ROL-09 (`ROLE_VIEW`): quem tem o perfil; outro tenant → 404. */
@Injectable()
export class ListRoleAssignmentsQuery {
  constructor(private readonly support: RoleAssignmentSupport) {}

  execute(roleId: string): Promise<RoleAssignmentDto[]> {
    return this.support.transactions.read(async (tx) => {
      const actor = await this.support.actors.resolve(tx, this.support.clock());
      authorizeActor(actor, 'ROLE_VIEW', 'NONE');
      const role = await this.support.roles.findById(tx, roleId);
      if (!role) throw roleNotFound();
      return this.support.toDtos(tx, await this.support.assignments.listByRole(tx, role.id));
    });
  }
}

/**
 * `AssignRoleCommand` — ROL-11 (US-096 · fluxo principal, passo 4 · RN-IAM-89..94/98), na ordem:
 * `ROLE_ASSIGN` (+ MFA — POL-14) → vínculo do tenant (404) → vínculo ativo (403
 * `MEMBERSHIP_INACTIVE`) → corpo e referências (422) → POL-13 (403) → POL-15 (422) → duplicada
 * (409 — a corrida é decidida pelo índice parcial) → `RoleAssignment` + `role.assign` +
 * `RoleAssigned`, atômicos.
 */
@Injectable()
export class AssignRoleCommand {
  constructor(private readonly support: RoleAssignmentSupport) {}

  async execute(input: {
    readonly userId: string;
    readonly body: AssignRole;
  }): Promise<RoleAssignmentDto> {
    const mfaPolicy = await this.support.identity.mfaPolicy();
    const context = requireRequestContext();
    const now = this.support.clock();
    const { dto, assignment } = await this.support.mutate(async (tx) => {
      const actor = await this.support.actors.resolve(tx, now);
      authorizeActor(
        actor,
        'ROLE_ASSIGN',
        mfaPolicy,
        'Você não tem permissão para atribuir perfis.',
      );
      const membership = await this.support.membershipOrNotFound(tx, input.userId);
      if (
        membership.status !== 'ACTIVE' ||
        (membership.expiresAt !== null && membership.expiresAt.getTime() <= now.getTime())
      ) {
        throw new ApiError('MEMBERSHIP_INACTIVE', {
          detail: ROLE_ASSIGNMENT_MEMBERSHIP_INACTIVE_MESSAGE,
          auditReasonCode: 'RN-IAM-90',
        });
      }
      const { role, department, errors } = await this.references(tx, input.body);
      let draft: RoleAssignment;
      try {
        draft = grantRoleAssignment(
          {
            membershipId: membership.id,
            roleId: input.body.roleId,
            scopeType: input.body.scopeType,
            scopeOrganizationId: input.body.scopeOrganizationId,
            scopeDepartmentId: input.body.scopeDepartmentId,
            includeSubtree: input.body.includeSubtree,
            validFrom:
              input.body.validFrom === undefined ? undefined : new Date(input.body.validFrom),
            validUntil:
              input.body.validUntil === undefined || input.body.validUntil === null
                ? null
                : new Date(input.body.validUntil),
          },
          {
            id: newId(),
            tenantId: context.tenantId ?? '',
            now,
            userId: context.actor.userId ?? '',
            membership,
          },
        );
      } catch (error) {
        if (error instanceof AssignmentValidationError) {
          throw validationError([...errors, ...error.errors]);
        }
        throw error;
      }
      if (errors.length > 0 || !role) throw validationError(errors);

      const missing = escalatedPermissions(
        await this.support.roles.permissionsOf(tx, role.id),
        draft,
        actor,
        (id) => (id === draft.scopeDepartmentId ? department : undefined),
      );
      if (missing.length > 0) {
        throw new ApiError('PRIVILEGE_ESCALATION_FORBIDDEN', {
          detail: ROLE_ASSIGNMENT_ESCALATION_MESSAGE,
          extensions: { permissions: missing },
          auditReasonCode: 'POL-13',
        });
      }
      if (externalAssignmentForbidden(membership.type, role)) {
        throw new ApiError('EXTERNAL_HIGH_RISK_ROLE', {
          detail: ROLE_ASSIGNMENT_EXTERNAL_MESSAGE,
          auditReasonCode: 'POL-15',
        });
      }
      if (await this.support.assignments.findActiveDuplicate(tx, draft)) throw duplicate();
      try {
        await this.support.assignments.insert(tx, draft);
      } catch (error) {
        // Corrida de duas atribuições idênticas: o índice único parcial decide.
        if (error instanceof RoleAssignmentAlreadyExistsError) throw duplicate();
        throw error;
      }
      await this.support.audit.record(tx, {
        action: 'role.assign',
        entityType: 'RoleAssignment',
        entityId: draft.id,
        metadata: {
          membershipId: draft.membershipId,
          roleId: draft.roleId,
          scopeType: draft.scopeType,
          ...(draft.scopeOrganizationId ? { scopeOrganizationId: draft.scopeOrganizationId } : {}),
          ...(draft.scopeDepartmentId ? { scopeDepartmentId: draft.scopeDepartmentId } : {}),
          validFrom: draft.validFrom.toISOString(),
          ...(draft.validUntil ? { validUntil: draft.validUntil.toISOString() } : {}),
        },
      });
      const scopeId = draft.scopeOrganizationId ?? draft.scopeDepartmentId;
      await this.support.outbox.record(
        tx,
        RoleAssigned.of({
          aggregateId: draft.id,
          payload: {
            roleAssignmentId: draft.id,
            membershipId: draft.membershipId,
            roleId: draft.roleId,
            scopeType: draft.scopeType,
            ...(scopeId ? { scopeId } : {}),
            ...(draft.validUntil ? { validUntil: draft.validUntil.toISOString() } : {}),
          },
        }),
      );
      return { dto: await this.support.toDto(tx, draft), assignment: draft };
    });
    await this.support.invalidatePermissions(assignment.membershipId);
    this.support.logChange('role.assignment_created', assignment);
    return dto;
  }

  /** V-03 (RN-IAM-90): perfil e órgão/unidade do escopo existentes e ativos no tenant. */
  private async references(
    tx: TenantTx,
    body: AssignRole,
  ): Promise<{
    role: Role | null;
    department: { organizationId: string; pathIds: readonly string[] } | undefined;
    errors: FieldError[];
  }> {
    const errors: FieldError[] = [];
    const role = await this.support.roles.findById(tx, body.roleId);
    if (!role) {
      errors.push({
        field: 'roleId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione um perfil válido.',
      });
    } else if (!role.isActive) {
      errors.push({
        field: 'roleId',
        code: 'REFERENCE_INACTIVE',
        message: 'Selecione um perfil válido.',
      });
    }
    if (body.scopeType === 'ORGANIZATION' && body.scopeOrganizationId) {
      const organization = (
        await this.support.references.organizationsByIds(tx, [body.scopeOrganizationId])
      ).get(body.scopeOrganizationId);
      if (!organization?.isActive) {
        errors.push({
          field: 'scopeOrganizationId',
          code: organization ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
          message: 'Selecione um órgão válido.',
        });
      }
    }
    let department: DepartmentReference | undefined;
    if (body.scopeType === 'DEPARTMENT' && body.scopeDepartmentId) {
      department = (
        await this.support.references.departmentsByIds(tx, [body.scopeDepartmentId])
      ).get(body.scopeDepartmentId);
      if (!department?.isActive) {
        errors.push({
          field: 'scopeDepartmentId',
          code: department ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma unidade válida.',
        });
      }
    }
    return { role: role?.isActive ? role : null, department, errors };
  }
}

/**
 * `RevokeRoleAssignmentCommand` — ROL-12 (fluxo principal, passo 7 · RN-IAM-95..97), na ordem:
 * `ROLE_ASSIGN` (+ MFA) → atribuição do tenant (404) → já revogada (409 `INVALID_STATE`) → versão
 * (412) → POL-16 (403 `PERMISSION_DENIED`, `reasonCode = POL-16`) → POL-12: revogar uma
 * `ADMIN_ORGAO`/`TENANT` vigente trava os vínculos administradores (`FOR UPDATE`) e exige outro
 * vínculo `ACTIVE` com a mesma atribuição vigente (409 `LAST_ADMIN_REQUIRED`) — de duas revogações
 * simultâneas, a segunda espera a trava e já vê a primeira. Grava `revokedAt/revokedById/
 * revocationReason`, `role.revoke` (só `hasReason`) e `RoleRevoked`.
 */
@Injectable()
export class RevokeRoleAssignmentCommand {
  constructor(private readonly support: RoleAssignmentSupport) {}

  async execute(input: {
    readonly id: string;
    readonly reason?: string | null | undefined;
    readonly expectedVersion: number;
  }): Promise<RoleAssignmentDto> {
    const mfaPolicy = await this.support.identity.mfaPolicy();
    const context = requireRequestContext();
    const now = this.support.clock();
    const { dto, assignment } = await this.support.mutate(async (tx) => {
      const actor = await this.support.actors.resolve(tx, now);
      authorizeActor(
        actor,
        'ROLE_ASSIGN',
        mfaPolicy,
        'Você não tem permissão para revogar perfis.',
      );
      const current = await this.support.assignments.findById(tx, input.id);
      if (!current) throw assignmentNotFound();
      if (current.revokedAt !== null) {
        throw new ApiError('INVALID_STATE', { detail: 'Esta atribuição já foi revogada.' });
      }
      if (current.version !== input.expectedVersion) throw versionConflict();
      await this.assertSelfProtection(tx, current, context.actor.membershipId, now);
      await this.assertNotLastAdmin(tx, current, now);

      let revoked: RoleAssignment;
      try {
        revoked = revokeRoleAssignment(current, {
          now,
          userId: context.actor.userId ?? '',
          reason: input.reason,
        });
      } catch (error) {
        if (error instanceof AssignmentAlreadyRevokedError) {
          throw new ApiError('INVALID_STATE', { detail: 'Esta atribuição já foi revogada.' });
        }
        throw error;
      }
      if (!(await this.support.assignments.revoke(tx, revoked, input.expectedVersion))) {
        throw versionConflict();
      }
      await this.support.audit.record(tx, {
        action: 'role.revoke',
        entityType: 'RoleAssignment',
        entityId: current.id,
        changes: [{ path: 'status', old: 'ACTIVE', new: 'REVOKED' }],
        // O motivo fica na atribuição; a auditoria só diz se houve (Logs).
        metadata: {
          membershipId: current.membershipId,
          roleId: current.roleId,
          scopeType: current.scopeType,
          hasReason: revoked.revocationReason !== null,
        },
      });
      await this.support.outbox.record(
        tx,
        RoleRevoked.of({
          aggregateId: current.id,
          payload: {
            roleAssignmentId: current.id,
            membershipId: current.membershipId,
            roleId: current.roleId,
          },
        }),
      );
      return { dto: await this.support.toDto(tx, revoked), assignment: revoked };
    });
    await this.support.invalidatePermissions(assignment.membershipId);
    this.support.logChange('role.assignment_revoked', assignment);
    return dto;
  }

  /** POL-16 (RN-IAM-97): a própria última atribuição administrativa vigente não sai. */
  private async assertSelfProtection(
    tx: TenantTx,
    target: RoleAssignment,
    actorMembershipId: string | null,
    now: Date,
  ): Promise<void> {
    if (actorMembershipId !== target.membershipId) return;
    const administrative = async (roleId: string) => {
      const role = await this.support.roles.findById(tx, roleId);
      return (
        role?.isActive === true &&
        isAdministrativeRole(await this.support.roles.permissionsOf(tx, roleId))
      );
    };
    if (!(await administrative(target.roleId))) return;
    let others = 0;
    for (const item of await this.support.assignments.listByMembership(tx, target.membershipId)) {
      if (item.id !== target.id && isEffective(item, now) && (await administrative(item.roleId))) {
        others += 1;
      }
    }
    if (
      violatesSelfProtection({
        targetMembershipId: target.membershipId,
        actorMembershipId,
        targetIsAdministrative: true,
        otherAdministrativeEffective: others,
      })
    ) {
      throw new ApiError('PERMISSION_DENIED', {
        detail: ROLE_ASSIGNMENT_SELF_PROTECTION_MESSAGE,
        auditReasonCode: 'POL-16',
      });
    }
  }

  /** POL-12 (RN-IAM-96) sob trava dos vínculos administradores. */
  private async assertNotLastAdmin(tx: TenantTx, target: RoleAssignment, now: Date): Promise<void> {
    if (target.scopeType !== 'TENANT' || !isEffective(target, now)) return;
    const role = await this.support.roles.findById(tx, target.roleId);
    if (role?.key !== PROTECTED_ROLE_KEY) return;
    const candidates = await this.support.assignments.membershipIdsWithRole(
      tx,
      role.id,
      now,
      'TENANT',
    );
    await this.support.identity.lockActiveMemberships(tx, candidates, now);
    // Relido depois da trava: uma revogação concorrente já confirmada não conta mais.
    const admins = await this.support.assignments.membershipIdsWithRole(tx, role.id, now, 'TENANT');
    const active = await this.support.identity.lockActiveMemberships(tx, admins, now);
    if (!active.some((membershipId) => membershipId !== target.membershipId)) {
      throw new ApiError('LAST_ADMIN_REQUIRED', {
        detail: ROLE_ASSIGNMENT_LAST_ADMIN_MESSAGE,
        auditReasonCode: 'POL-12',
      });
    }
  }
}
