import type { PermissionCode } from '@contrataflow/types';
import {
  MEMBERSHIP_INVALID_STATE_MESSAGE,
  MEMBERSHIP_LAST_ADMIN_MESSAGE,
  MEMBERSHIP_SELF_PROTECTION_MESSAGE,
  MembershipReactivated,
  MembershipRevoked,
  MembershipSuspended,
  MembershipUpdated,
} from '@contrataflow/validation';
import type {
  FieldError,
  MembershipDetailMeta,
  TenantMembershipDetailDto,
  UpdateMembership,
  UpdateMembershipDepartments,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Histogram } from '@opentelemetry/api';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MembershipReferences } from '#shared/auth/membership-references.js';
import { invalidateEffectivePermissions } from '#shared/auth/permission-cache.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';

import { INVITATION_REPOSITORY, MEMBERSHIP_SETTINGS } from './invitation-ports.js';
import type { InvitationRepository, MembershipSettingsPort } from './invitation-ports.js';
import { MembershipCommand, tenantOf } from './invitation.commands.js';
import { toMembershipDto } from './invitation.view.js';
import { MEMBERSHIP_REPOSITORY } from './membership-ports.js';
import type { MembershipRepository, MembershipState } from './membership-ports.js';
import { IDENTITY_CLOCK, IDENTITY_TENANT_TRANSACTIONS, TENANT_MFA_POLICY } from './ports.js';
import type { Clock, IdentityTenantTransactions, TenantMfaPolicyPort } from './ports.js';
import {
  allowedMembershipActions,
  canTransition,
  departmentReferenceErrors,
  membershipValidityError,
  primaryFirst,
  profileChanges,
  removesAccess,
  sameDepartments,
  transitionSources,
  transitionTarget,
  validityNotAllowedError,
  violatesLastAdmin,
  violatesSelfProtection,
} from '../domain/membership-lifecycle.js';
import type { MembershipTransition } from '../domain/membership-lifecycle.js';

/** Resposta de USR-07..12: o detalhe e `meta.allowedActions`/`isSelf` (api.md §1.5). */
export interface MembershipDetailResult {
  readonly data: TenantMembershipDetailDto;
  readonly meta: MembershipDetailMeta;
}

type MutationAction = 'update' | 'departments_update' | 'suspend' | 'reactivate' | 'revoke';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function userNotFound(): ApiError {
  return new ApiError('USER_NOT_FOUND', { detail: 'Usuário não encontrado.' });
}

function versionConflict(): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Os dados foram alterados por outra pessoa. Recarregue.',
  });
}

function invalidState(): ApiError {
  return new ApiError('INVALID_STATE', { detail: MEMBERSHIP_INVALID_STATE_MESSAGE });
}

/**
 * Falha inesperada ou 5xx (banco fora → `DEPENDENCY_UNAVAILABLE`) → `membership.mutation_failed`;
 * recusas de negócio (4xx) não são falhas.
 */
function failureCode(error: unknown): string | null {
  if (error instanceof ApiError) return error.status >= 500 ? error.code : null;
  return 'INTERNAL_ERROR';
}

/**
 * Base de USR-07..12 (US-092): autorização pela porta do `access` (`USER_VIEW`/`USER_MANAGE`, MFA
 * do risco alto — POL-14), o detalhe com as lotações nomeadas e, depois do commit de cada
 * mutação, a invalidação imediata do cache de permissões efetivas do vínculo (RN-IAM-61 — o
 * `PermissionCacheInvalidator` repete pelo evento `membership.*`; o TTL de 5 min é a rede de
 * segurança), o log `membership.mutation` e a latência por ação.
 */
abstract class MembershipAdministration extends MembershipCommand {
  private static durationHistogram: Histogram | undefined;

  constructor(
    references: MembershipReferences,
    mfaPolicies: TenantMfaPolicyPort,
    clock: Clock,
    protected readonly memberships: MembershipRepository,
    protected readonly transactions: IdentityTenantTransactions,
    private readonly cache: TenantCache,
  ) {
    super(references, mfaPolicies, clock);
  }

  protected async stateOrNotFound(tx: TenantTx, userId: string): Promise<MembershipState> {
    const state = await this.memberships.findStateByUser(tx, userId);
    if (!state) throw userNotFound();
    return state;
  }

  protected async detailResult(
    tx: TenantTx,
    membershipId: string,
  ): Promise<MembershipDetailResult> {
    const view = await this.memberships.detail(tx, membershipId);
    if (!view) throw userNotFound();
    const departments = await this.references.departmentsByIds(tx, view.departmentIds);
    const isSelf = requireRequestContext().actor.membershipId === view.id;
    return {
      data: {
        ...toMembershipDto(view),
        departments: view.departmentIds.map((id, index) => ({
          id,
          name: departments.get(id)?.name ?? '',
          isActive: departments.get(id)?.isActive ?? false,
          isPrimary: index === 0,
        })),
        suspendedAt: iso(view.suspendedAt),
        suspensionReason: view.suspensionReason,
        revokedAt: iso(view.revokedAt),
        revocationReason: view.revocationReason,
      },
      meta: {
        allowedActions: allowedMembershipActions({
          status: view.status,
          canManage: this.references.hasPermission('USER_MANAGE'),
          isSelf,
        }),
        isSelf,
      },
    };
  }

  /** Executa a mutação numa transação, com a telemetria da story (Logs). */
  protected async mutate(
    action: MutationAction,
    permission: PermissionCode,
    work: (tx: TenantTx) => Promise<MembershipDetailResult & { readonly changed: boolean }>,
  ): Promise<MembershipDetailResult> {
    await this.authorize(permission);
    const startedAt = performance.now();
    const context = requireRequestContext();
    let result: MembershipDetailResult & { readonly changed: boolean };
    try {
      result = await this.transactions.run(work);
    } catch (error) {
      const errorCode = failureCode(error);
      if (errorCode !== null) {
        this.logger.error(
          {
            event: 'membership.mutation_failed',
            action,
            errorCode,
            tenantId: context.tenantId,
            correlationId: context.correlationId,
          },
          'membership.mutation_failed',
        );
      }
      throw error;
    }
    if (result.changed) await this.invalidatePermissions(result.data.id);
    const durationMs = Math.round(performance.now() - startedAt);
    MembershipAdministration.histogram().record(durationMs, { action });
    this.logger.log(
      {
        event: 'membership.mutation',
        membershipId: result.data.id,
        action,
        changed: result.changed,
        durationMs,
        tenantId: context.tenantId,
        correlationId: context.correlationId,
      },
      'membership.mutation',
    );
    return { data: result.data, meta: result.meta };
  }

  /**
   * RN-IAM-61: `DEL cf:{env}:t:{tenantId}:access:eff:{membershipId}` com troca do token de geração
   * (US-097); Redis fora não desfaz nada.
   */
  private async invalidatePermissions(membershipId: string): Promise<void> {
    try {
      await invalidateEffectivePermissions(this.cache, membershipId);
    } catch (error) {
      this.logger.warn(
        {
          event: 'access.cache_invalidation_failed',
          membershipId,
          cause: error instanceof Error ? error.name : 'unknown',
          correlationId: requireRequestContext().correlationId,
        },
        'access.cache_invalidation_failed',
      );
    }
  }

  private static histogram(): Histogram {
    MembershipAdministration.durationHistogram ??= metrics
      .getMeter('contrataflow-api')
      .createHistogram('cf_membership_mutation_duration_ms', {
        description: 'Latência das mutações de vínculo (USR-08..12) por ação.',
        unit: 'ms',
      });
    return MembershipAdministration.durationHistogram;
  }
}

/** `GetMembershipQuery` — USR-07 (`USER_VIEW`): 404 `USER_NOT_FOUND` fora do tenant (RLS). */
@Injectable()
export class GetMembershipQuery extends MembershipAdministration {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(MEMBERSHIP_REPOSITORY) memberships: MembershipRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) transactions: IdentityTenantTransactions,
    cache: TenantCache,
  ) {
    super(references, mfaPolicies, clock, memberships, transactions, cache);
  }

  async execute(input: { readonly userId: string }): Promise<MembershipDetailResult> {
    await this.authorize('USER_VIEW');
    return this.transactions.read(async (tx) => {
      const state = await this.stateOrNotFound(tx, input.userId);
      return this.detailResult(tx, state.id);
    });
  }
}

/**
 * `UpdateMembershipCommand` — USR-08 (RN-IAM-55/63): cargo, matrícula e — só `EXTERNAL` — a
 * validade (hoje < validade ≤ hoje + `security.externalMembershipMaxDays`). `type` e `invitedById`
 * não são editáveis. Sem mudança efetiva, nada é gravado (sem evento nem auditoria).
 */
@Injectable()
export class UpdateMembershipCommand extends MembershipAdministration {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(MEMBERSHIP_REPOSITORY) memberships: MembershipRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) transactions: IdentityTenantTransactions,
    cache: TenantCache,
    @Inject(MEMBERSHIP_SETTINGS) private readonly settings: MembershipSettingsPort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super(references, mfaPolicies, clock, memberships, transactions, cache);
  }

  execute(input: {
    readonly userId: string;
    readonly body: UpdateMembership;
    readonly expectedVersion: number;
  }): Promise<MembershipDetailResult> {
    const now = this.clock();
    const actorId = requireRequestContext().actor.userId;
    return this.mutate('update', 'USER_MANAGE', async (tx) => {
      const state = await this.stateOrNotFound(tx, input.userId);
      if (state.status === 'REVOKED') throw invalidState();
      const expiresAt =
        input.body.expiresAt === undefined ? undefined : new Date(input.body.expiresAt);
      if (expiresAt !== undefined) {
        const maxDays = await this.settings.externalMembershipMaxDays(tx);
        const error =
          validityNotAllowedError(state.type) ?? membershipValidityError(expiresAt, now, maxDays);
        if (error) throw validationError([error]);
      }
      if (state.version !== input.expectedVersion) throw versionConflict();
      const changes = profileChanges(state, {
        jobTitle: input.body.jobTitle,
        registrationNumber: input.body.registrationNumber,
        expiresAt,
      });
      if (changes.length === 0) {
        return { ...(await this.detailResult(tx, state.id)), changed: false };
      }
      const patch: {
        jobTitle?: string | null;
        registrationNumber?: string | null;
        expiresAt?: Date;
      } = {};
      for (const change of changes) {
        if (change.path === 'expiresAt') {
          if (expiresAt !== undefined) patch.expiresAt = expiresAt;
        } else {
          patch[change.path] = change.new;
        }
      }
      const updated = await this.memberships.updateProfile(tx, {
        membershipId: state.id,
        expectedVersion: input.expectedVersion,
        now,
        actorId,
        ...patch,
      });
      if (!updated) throw versionConflict();
      await this.audit.record(tx, {
        action: 'membership.update',
        entityType: 'TenantMembership',
        entityId: state.id,
        changes,
      });
      await this.outbox.record(
        tx,
        MembershipUpdated.of({
          aggregateId: state.id,
          payload: { membershipId: state.id, changedFields: changes.map((change) => change.path) },
        }),
      );
      return { ...(await this.detailResult(tx, state.id)), changed: true };
    });
  }
}

/**
 * `UpdateMembershipDepartmentsCommand` — USR-09 (RN-IAM-56/63): substitui a lotação em bloco
 * (delete + insert, a principal marcada) na mesma transação da nova versão do vínculo,
 * `membership.departments_update` (anteriores/novas) e `MembershipUpdated` (`departments`).
 * Unidades inexistentes, inativas ou de outro tenant → 422 sem revelar qual (V-03).
 */
@Injectable()
export class UpdateMembershipDepartmentsCommand extends MembershipAdministration {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(MEMBERSHIP_REPOSITORY) memberships: MembershipRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) transactions: IdentityTenantTransactions,
    cache: TenantCache,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: InvitationRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super(references, mfaPolicies, clock, memberships, transactions, cache);
  }

  execute(input: {
    readonly userId: string;
    readonly body: UpdateMembershipDepartments;
    readonly expectedVersion: number;
  }): Promise<MembershipDetailResult> {
    const now = this.clock();
    const actorId = requireRequestContext().actor.userId;
    return this.mutate('departments_update', 'USER_MANAGE', async (tx) => {
      const state = await this.stateOrNotFound(tx, input.userId);
      if (state.status === 'REVOKED') throw invalidState();
      const departments = await this.references.departmentsByIds(tx, input.body.departmentIds);
      const errors: FieldError[] = departmentReferenceErrors(input.body.departmentIds, departments);
      if (errors.length > 0) throw validationError(errors);
      if (state.version !== input.expectedVersion) throw versionConflict();
      const next = primaryFirst(input.body.departmentIds, input.body.primaryDepartmentId);
      if (sameDepartments(state.departmentIds, next)) {
        return { ...(await this.detailResult(tx, state.id)), changed: false };
      }
      const bumped = await this.memberships.bumpVersion(tx, {
        membershipId: state.id,
        expectedVersion: input.expectedVersion,
        now,
        actorId,
      });
      if (!bumped) throw versionConflict();
      await this.invitations.replaceDepartments(tx, {
        tenantId: tenantOf(),
        membershipId: state.id,
        departmentIds: next,
        createdById: actorId,
        ids: next.map(() => newId()),
        now,
      });
      await this.audit.record(tx, {
        action: 'membership.departments_update',
        entityType: 'TenantMembership',
        entityId: state.id,
        changes: [
          {
            path: 'departments',
            old: {
              departmentIds: state.departmentIds,
              primaryDepartmentId: state.departmentIds[0] ?? null,
            },
            new: { departmentIds: next, primaryDepartmentId: next[0] },
          },
        ],
      });
      await this.outbox.record(
        tx,
        MembershipUpdated.of({
          aggregateId: state.id,
          payload: { membershipId: state.id, changedFields: ['departments'] },
        }),
      );
      return { ...(await this.detailResult(tx, state.id)), changed: true };
    });
  }
}

const TRANSITION_AUDIT = {
  SUSPEND: 'membership.suspend',
  REACTIVATE: 'membership.reactivate',
  REVOKE: 'membership.revoke',
} as const;

const TRANSITION_LOG: Readonly<Record<MembershipTransition, MutationAction>> = {
  SUSPEND: 'suspend',
  REACTIVATE: 'reactivate',
  REVOKE: 'revoke',
};

/**
 * `ChangeMembershipStatusCommand` — USR-10/11/12 (RN-IAM-57..60 · POL-12/16), na ordem: vínculo do
 * tenant (404) → autoproteção (403 `PERMISSION_DENIED`, auditado como `access.denied` `POL-16`) →
 * status de origem (409 `INVALID_STATE`) → versão (412) → anti-bloqueio: se o alvo tem o
 * `ADMIN_ORGAO` vigente, os administradores `ACTIVE` são travados (`FOR UPDATE`) e contados — o
 * último não sai (409 `LAST_ADMIN_REQUIRED`, auditado); de duas remoções simultâneas, a segunda
 * espera a trava e já vê a primeira. A transição é condicional ao status e à versão. A
 * reativação exige o tenant `ACTIVE` (RN-IAM-58): fora dele o guard já recusa qualquer comando.
 * Revogar encerra as sessões do usuário na instituição pelo `MembershipRevoked`
 * (`SessionTerminationHandler` — RN-IAM-60); o vínculo `REVOKED` sai da lista utilizável de ME-04.
 */
@Injectable()
export class ChangeMembershipStatusCommand extends MembershipAdministration {
  constructor(
    references: MembershipReferences,
    @Inject(TENANT_MFA_POLICY) mfaPolicies: TenantMfaPolicyPort,
    @Inject(IDENTITY_CLOCK) clock: Clock,
    @Inject(MEMBERSHIP_REPOSITORY) memberships: MembershipRepository,
    @Inject(IDENTITY_TENANT_TRANSACTIONS) transactions: IdentityTenantTransactions,
    cache: TenantCache,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {
    super(references, mfaPolicies, clock, memberships, transactions, cache);
  }

  execute(input: {
    readonly action: MembershipTransition;
    readonly userId: string;
    readonly reason?: string | null | undefined;
    readonly expectedVersion: number;
  }): Promise<MembershipDetailResult> {
    const now = this.clock();
    const context = requireRequestContext();
    const reason = input.reason && input.reason.length > 0 ? input.reason : null;
    return this.mutate(TRANSITION_LOG[input.action], 'USER_MANAGE', async (tx) => {
      const state = await this.stateOrNotFound(tx, input.userId);
      if (violatesSelfProtection(input.action, state.id, context.actor.membershipId)) {
        throw new ApiError('PERMISSION_DENIED', {
          detail: MEMBERSHIP_SELF_PROTECTION_MESSAGE,
          auditReasonCode: 'POL-16',
        });
      }
      if (!canTransition(input.action, state.status)) throw invalidState();
      if (state.version !== input.expectedVersion) throw versionConflict();
      if (removesAccess(input.action)) await this.assertNotLastAdmin(tx, state.id, now);

      const to = transitionTarget(input.action);
      const changed = await this.memberships.changeStatus(tx, {
        membershipId: state.id,
        expectedVersion: input.expectedVersion,
        from: transitionSources(input.action),
        to,
        reason,
        now,
        actorId: context.actor.userId,
      });
      if (!changed) throw versionConflict();
      await this.audit.record(tx, {
        action: TRANSITION_AUDIT[input.action],
        entityType: 'TenantMembership',
        entityId: state.id,
        changes: [{ path: 'status', old: state.status, new: to }],
        // O motivo fica no vínculo; a auditoria e o evento só dizem se houve (Logs).
        metadata: input.action === 'REACTIVATE' ? {} : { hasReason: reason !== null },
      });
      await this.outbox.record(tx, this.eventOf(input.action, state.id, reason !== null));
      return { ...(await this.detailResult(tx, state.id)), changed: true };
    });
  }

  /** POL-12 sob trava dos administradores ativos. */
  private async assertNotLastAdmin(tx: TenantTx, membershipId: string, now: Date): Promise<void> {
    const admins = await this.references.adminMembershipIds(tx, now);
    if (!admins.has(membershipId)) return;
    const active = await this.memberships.lockActiveMemberships(tx, [...admins], now);
    if (violatesLastAdmin(membershipId, active)) {
      throw new ApiError('LAST_ADMIN_REQUIRED', { detail: MEMBERSHIP_LAST_ADMIN_MESSAGE });
    }
  }

  private eventOf(action: MembershipTransition, membershipId: string, hasReason: boolean) {
    switch (action) {
      case 'SUSPEND':
        return MembershipSuspended.of({
          aggregateId: membershipId,
          payload: { membershipId, hasReason },
        });
      case 'REACTIVATE':
        return MembershipReactivated.of({ aggregateId: membershipId, payload: { membershipId } });
      case 'REVOKE':
        return MembershipRevoked.of({
          aggregateId: membershipId,
          payload: { membershipId, hasReason },
        });
    }
  }
}
