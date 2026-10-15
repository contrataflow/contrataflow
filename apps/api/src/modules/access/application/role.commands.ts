import type { PermissionCode } from '@contrataflow/types';
import { RoleCreated, RoleUpdated } from '@contrataflow/validation';
import type {
  CreateRole,
  DeactivateRole,
  RoleDto,
  RoleWithPermissionsDto,
  UpdateRole,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { hasSecondFactor } from '#shared/auth/mfa-policy.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_COUNTER,
  ROLE_REPOSITORY,
  RoleAlreadyExistsError,
} from './ports.js';
import type {
  AccessClock,
  AccessTransactions,
  RoleAssignmentCounter,
  RoleRepository,
} from './ports.js';
import { authorizeActor, RoleActorResolver } from './role-actor.js';
import {
  countRoleChange,
  deactivationNotConfirmed,
  externalAssignmentMfaRequired,
  lastAdminRequired,
  logRoleFailure,
  privilegeEscalation,
  protectedPermissionRemoval,
  roleAlreadyExists,
  roleKeyUnderivable,
  roleNotFound,
  toRoleDto,
  versionConflict,
} from './role.errors.js';
import type { RoleOperation } from './role.errors.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { PERMISSION_RISKS } from '../domain/permission-grants.js';
import {
  assertNoPrivilegeEscalation,
  assertProtectedPermissionsKept,
  createRole,
  DeactivationNotConfirmedError,
  deactivateRole,
  diffPermissions,
  duplicateRoleName,
  externalAssignmentNeedsMfa,
  LastAdminRequiredError,
  PrivilegeEscalationError,
  ProtectedPermissionRemovalError,
  RoleKeyUnderivableError,
  updateRoleDetails,
} from '../domain/role-management.js';
import type { ActorGrants, NewRoleInput } from '../domain/role-management.js';
import type { Role } from '../domain/role.js';
import { grantPermission } from '../domain/role.js';

const riskOf = (code: PermissionCode) => PERMISSION_RISKS[code];

/**
 * Dependências e passos comuns dos comandos de perfil (US-095 · padrão de comando transacional da
 * US-001): validação → autorização (`ROLE_MANAGE` + POL-12/13/14) → domínio → `RolePermission`
 * (diff) → auditoria → outbox → commit, tudo numa transação com o `app.tenant_id` do contexto.
 */
@Injectable()
export class RoleCommandSupport {
  readonly logger = new Logger('Roles');

  constructor(
    @Inject(ROLE_REPOSITORY) readonly roles: RoleRepository,
    @Inject(ROLE_ASSIGNMENT_COUNTER) readonly assignments: RoleAssignmentCounter,
    @Inject(ACCESS_TRANSACTIONS) private readonly transactions: AccessTransactions,
    @Inject(ACCESS_CLOCK) readonly clock: AccessClock,
    @Inject(AUDIT_TRAIL) readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) readonly outbox: OutboxWriterPort,
    private readonly actors: RoleActorResolver,
    private readonly identity: IdentityFacade,
  ) {}

  /**
   * Executa `work` numa transação depois de autorizar `ROLE_MANAGE` (+ MFA conforme
   * `security.mfaPolicy`) com as permissões efetivas do ator lidas na mesma transação. Falha de
   * gravação → `error role.update_failed`; sucesso → `info role.created|role.updated` e métrica.
   */
  async run<T extends { readonly role: Role; readonly log: RoleChangeLog | null }>(
    operation: RoleOperation,
    work: (tx: TenantTx, actor: ActorGrants, context: RequestContext) => Promise<T>,
  ): Promise<T> {
    const mfaPolicy = await this.identity.mfaPolicy();
    const context = requireRequestContext();
    let result: T;
    try {
      result = await this.transactions.run(async (tx) => {
        const actor = await this.actors.resolve(tx);
        authorizeActor(actor, 'ROLE_MANAGE', mfaPolicy);
        return work(tx, actor, context);
      });
    } catch (error) {
      logRoleFailure(this.logger, error, context.correlationId);
      throw error;
    }
    if (result.log !== null) {
      const event = result.log.created ? 'role.created' : 'role.updated';
      this.logger.log(
        {
          event,
          roleId: result.role.id,
          key: result.role.key,
          actorId: context.actor.userId,
          permissionsAdded: result.log.added,
          permissionsRemoved: result.log.removed,
          correlationId: context.correlationId,
        },
        event,
      );
      countRoleChange(operation);
    }
    return result;
  }

  async load(tx: TenantTx, id: string, expectedVersion?: number): Promise<Role> {
    const role = await this.roles.findById(tx, id);
    if (!role) throw roleNotFound();
    if (expectedVersion !== undefined && role.version !== expectedVersion) {
      throw versionConflict(role.version);
    }
    return role;
  }

  /** `UPDATE … WHERE version` (DEC-055); corrida → 412 com a versão vencedora. */
  async save(tx: TenantTx, next: Role, expectedVersion: number): Promise<Role> {
    try {
      await this.roles.update(tx, next, expectedVersion);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        const latest = await this.roles.findById(tx, next.id);
        throw versionConflict(latest?.version ?? expectedVersion + 1);
      }
      if (error instanceof RoleAlreadyExistsError) throw roleAlreadyExists();
      throw error;
    }
    return { ...next, version: expectedVersion + 1 };
  }

  async activeAssignments(tx: TenantTx, roleId: string): Promise<number> {
    return (await this.assignments.countActive(tx, [roleId])).get(roleId) ?? 0;
  }

  /** POL-13 (RN-IAM-81) → 403 `PRIVILEGE_ESCALATION_FORBIDDEN`. */
  assertCanGrant(granted: readonly PermissionCode[], actor: ActorGrants): void {
    try {
      assertNoPrivilegeEscalation(granted, actor);
    } catch (error) {
      if (error instanceof PrivilegeEscalationError) throw privilegeEscalation(error.permissions);
      throw error;
    }
  }

  /**
   * Cria o perfil e as concessões (ROL-03/07): unicidade de nome/chave (RN-IAM-87), auditoria
   * `role.create` e `RoleCreated`.
   */
  async insertRole(
    tx: TenantTx,
    input: NewRoleInput,
    permissions: readonly PermissionCode[],
    context: RequestContext,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<Role> {
    const now = this.clock();
    let draft: Role;
    try {
      draft = createRole(input, {
        id: newId(),
        tenantId: context.tenantId ?? '',
        now,
        userId: context.actor.userId,
      });
    } catch (error) {
      if (error instanceof RoleKeyUnderivableError) throw roleKeyUnderivable();
      throw error;
    }
    if (
      (await this.roles.findByName(tx, draft.name)) ||
      (await this.roles.findByKeys(tx, [draft.key])).length > 0
    ) {
      throw roleAlreadyExists();
    }
    try {
      await this.roles.insert(tx, draft);
    } catch (error) {
      // Corrida de duas criações: o índice único decide.
      if (error instanceof RoleAlreadyExistsError) throw roleAlreadyExists();
      throw error;
    }
    await this.roles.insertMissingGrants(
      tx,
      permissions.map((code) =>
        grantPermission(draft, code, { id: newId(), now, userId: context.actor.userId }),
      ),
    );
    const changes: AuditChange[] = [
      { path: 'name', old: null, new: draft.name },
      { path: 'description', old: null, new: draft.description },
      { path: 'allowExternalAssignment', old: null, new: draft.allowExternalAssignment },
    ];
    await this.audit.record(tx, {
      action: 'role.create',
      entityType: 'Role',
      entityId: draft.id,
      changes,
      metadata: { key: draft.key, permissionsGranted: [...permissions], ...metadata },
    });
    await this.outbox.record(
      tx,
      RoleCreated.of({
        aggregateId: draft.id,
        payload: { roleId: draft.id, key: draft.key, permissionsAdded: [...permissions] },
      }),
    );
    return draft;
  }

  async publishUpdated(
    tx: TenantTx,
    role: Role,
    diff: {
      readonly added: readonly PermissionCode[];
      readonly removed: readonly PermissionCode[];
    },
  ): Promise<void> {
    await this.outbox.record(
      tx,
      RoleUpdated.of({
        aggregateId: role.id,
        payload: {
          roleId: role.id,
          key: role.key,
          permissionsAdded: [...diff.added],
          permissionsRemoved: [...diff.removed],
        },
      }),
    );
  }
}

/** Contagens do log `role.created`/`role.updated` (nunca a lista de permissões). */
export interface RoleChangeLog {
  readonly created: boolean;
  readonly added: number;
  readonly removed: number;
}

/**
 * `CreateRoleCommand` — ROL-03 (US-095 · fluxo principal, passos 2–3 · RN-IAM-80/81/83/87): perfil
 * personalizado com chave gerada do nome, `permissions[]` opcional sujeito a POL-13 e
 * `allowExternalAssignment` com permissão `HIGH` sujeito a MFA (POL-14).
 */
@Injectable()
export class CreateRoleCommand {
  constructor(private readonly support: RoleCommandSupport) {}

  async execute(body: CreateRole): Promise<RoleDto> {
    const { role } = await this.support.run('create', async (tx, actor, context) => {
      const permissions = body.permissions ?? [];
      this.support.assertCanGrant(permissions, actor);
      if (
        externalAssignmentNeedsMfa({
          wasAllowed: false,
          willAllow: body.allowExternalAssignment ?? false,
          permissions,
          riskOf,
        }) &&
        !hasSecondFactor(context.amr)
      ) {
        throw externalAssignmentMfaRequired();
      }
      const created = await this.support.insertRole(tx, body, permissions, context);
      return {
        role: created,
        log: { created: true, added: permissions.length, removed: 0 },
      };
    });
    return toRoleDto(role, 0);
  }
}

/**
 * `DuplicateRoleCommand` — ROL-07 (FA-06 · RN-IAM-86): cópia `isSystem = false` com nome
 * "{nome} (cópia)" (ajustado para manter a unicidade), descrição e permissões da origem, sujeita a
 * POL-13. `allowExternalAssignment` não é copiado (nasce `false`). Origem inativa pode ser copiada —
 * é a alternativa à reativação (FA-07).
 */
@Injectable()
export class DuplicateRoleCommand {
  constructor(private readonly support: RoleCommandSupport) {}

  async execute(id: string): Promise<RoleDto> {
    const { role } = await this.support.run('duplicate', async (tx, actor, context) => {
      const source = await this.support.load(tx, id);
      const permissions = await this.support.roles.permissionsOf(tx, source.id);
      this.support.assertCanGrant(permissions, actor);
      const name = duplicateRoleName(source.name, await this.support.roles.namesAndKeys(tx));
      const created = await this.support.insertRole(
        tx,
        { name, description: source.description, allowExternalAssignment: false },
        permissions,
        context,
        { duplicatedFromRoleId: source.id },
      );
      return {
        role: created,
        log: { created: true, added: permissions.length, removed: 0 },
      };
    });
    return toRoleDto(role, 0);
  }
}

/**
 * `UpdateRoleCommand` — ROL-05 (fluxo principal, passo 8 · RN-IAM-80/83/87): nome, descrição e
 * `allowExternalAssignment`, com `If-Match`. A chave é imutável. Ligar a atribuição externa em perfil
 * com permissão `HIGH` exige MFA na sessão qualquer que seja a política (RN-IAM-83). Nada alterado
 * → 200 sem nova versão, auditoria nem evento.
 */
@Injectable()
export class UpdateRoleCommand {
  constructor(private readonly support: RoleCommandSupport) {}

  async execute(input: {
    readonly id: string;
    readonly patch: UpdateRole;
    readonly expectedVersion: number;
  }): Promise<RoleDto> {
    const { role, count } = await this.support.run('update', async (tx, _actor, context) => {
      const current = await this.support.load(tx, input.id, input.expectedVersion);
      const count = await this.support.activeAssignments(tx, current.id);
      const update = updateRoleDetails(current, input.patch, {
        now: this.support.clock(),
        userId: context.actor.userId,
      });
      if (update.changes.length === 0) return { role: current, count, log: null };

      const { next } = update;
      if (
        next.name !== current.name &&
        (await this.support.roles.findByName(tx, next.name, next.id))
      ) {
        throw roleAlreadyExists();
      }
      const externalHighRisk = externalAssignmentNeedsMfa({
        wasAllowed: current.allowExternalAssignment,
        willAllow: next.allowExternalAssignment,
        permissions: await this.support.roles.permissionsOf(tx, current.id),
        riskOf,
      });
      if (externalHighRisk && !hasSecondFactor(context.amr)) throw externalAssignmentMfaRequired();

      const saved = await this.support.save(tx, next, current.version);
      await this.support.audit.record(tx, {
        action: 'role.update',
        entityType: 'Role',
        entityId: current.id,
        changes: update.changes,
        metadata: {
          key: current.key,
          ...(externalHighRisk ? { externalAssignmentWithHighRisk: true, mfaVerified: true } : {}),
        },
      });
      await this.support.publishUpdated(tx, saved, { added: [], removed: [] });
      return { role: saved, count, log: { created: false, added: 0, removed: 0 } };
    });
    return toRoleDto(role, count);
  }
}

/**
 * `UpdateRolePermissionsCommand` — ROL-06 (fluxo principal, passos 5–7 · RN-IAM-81/82): recebe a
 * lista COMPLETA de códigos marcados, aplica POL-13 às permissões novas e a proteção do
 * `ADMIN_ORGAO` às removidas (recusa tudo — nada parcial), grava o diff em `role_permissions`, sobe
 * a versão do perfil e registra `role.permissions_update` + `RoleUpdated`.
 */
@Injectable()
export class UpdateRolePermissionsCommand {
  constructor(private readonly support: RoleCommandSupport) {}

  async execute(input: {
    readonly id: string;
    readonly permissions: readonly PermissionCode[];
    readonly expectedVersion: number;
  }): Promise<RoleWithPermissionsDto> {
    const { role, count, permissions } = await this.support.run(
      'permissions',
      async (tx, actor, context) => {
        const current = await this.support.load(tx, input.id, input.expectedVersion);
        const count = await this.support.activeAssignments(tx, current.id);
        const before = await this.support.roles.permissionsOf(tx, current.id);
        const diff = diffPermissions(before, input.permissions);
        this.support.assertCanGrant(diff.added, actor);
        try {
          assertProtectedPermissionsKept(current, diff.removed);
        } catch (error) {
          if (error instanceof ProtectedPermissionRemovalError) {
            throw protectedPermissionRemoval(error.permissions);
          }
          throw error;
        }
        if (diff.added.length === 0 && diff.removed.length === 0) {
          return { role: current, count, permissions: before, log: null };
        }

        const now = this.support.clock();
        // A versão sobe primeiro: o UPDATE trava a linha e serializa edições concorrentes da matriz.
        const saved = await this.support.save(
          tx,
          { ...current, updatedAt: now, updatedById: context.actor.userId },
          current.version,
        );
        await this.support.roles.removeGrants(tx, current.id, diff.removed);
        await this.support.roles.insertMissingGrants(
          tx,
          diff.added.map((code) =>
            grantPermission(current, code, { id: newId(), now, userId: context.actor.userId }),
          ),
        );
        await this.support.audit.record(tx, {
          action: 'role.permissions_update',
          entityType: 'Role',
          entityId: current.id,
          metadata: {
            key: current.key,
            permissionsAdded: [...diff.added],
            permissionsRemoved: [...diff.removed],
          },
        });
        await this.support.publishUpdated(tx, saved, diff);
        return {
          role: saved,
          count,
          permissions: await this.support.roles.permissionsOf(tx, current.id),
          log: { created: false, added: diff.added.length, removed: diff.removed.length },
        };
      },
    );
    return toRoleDto(role, count, permissions);
  }
}

/**
 * `DeactivateRoleCommand` — ROL-08 (FA-04/FA-05 · RN-IAM-84/85): `ADMIN_ORGAO` nunca (POL-12 →
 * 409 `LAST_ADMIN_REQUIRED`); com vínculos ativos exige `confirmDeactivate: true`. As atribuições
 * são preservadas e deixam de conceder permissões. Perfil já inativo → 200 sem alteração.
 */
@Injectable()
export class DeactivateRoleCommand {
  constructor(private readonly support: RoleCommandSupport) {}

  async execute(input: {
    readonly id: string;
    readonly body: DeactivateRole;
    readonly expectedVersion: number;
  }): Promise<RoleDto> {
    const { role, count } = await this.support.run('deactivate', async (tx, _actor, context) => {
      const current = await this.support.load(tx, input.id, input.expectedVersion);
      const count = await this.support.activeAssignments(tx, current.id);
      let next: Role | null;
      try {
        next = deactivateRole(
          current,
          { activeAssignments: count, confirmed: input.body.confirmDeactivate === true },
          { now: this.support.clock(), userId: context.actor.userId },
        );
      } catch (error) {
        if (error instanceof LastAdminRequiredError) {
          this.support.logger.warn(
            {
              event: 'role.deactivate_blocked',
              roleId: current.id,
              key: current.key,
              actorId: context.actor.userId,
              correlationId: context.correlationId,
            },
            'role.deactivate_blocked',
          );
          throw lastAdminRequired();
        }
        if (error instanceof DeactivationNotConfirmedError) {
          throw deactivationNotConfirmed(error.activeAssignments);
        }
        throw error;
      }
      if (next === null) return { role: current, count, log: null };

      const saved = await this.support.save(tx, next, current.version);
      await this.support.audit.record(tx, {
        action: 'role.deactivate',
        entityType: 'Role',
        entityId: current.id,
        changes: [{ path: 'isActive', old: true, new: false }],
        metadata: { key: current.key, activeAssignmentsAffected: count },
      });
      await this.support.publishUpdated(tx, saved, { added: [], removed: [] });
      return { role: saved, count, log: { created: false, added: 0, removed: 0 } };
    });
    return toRoleDto(role, count);
  }
}
