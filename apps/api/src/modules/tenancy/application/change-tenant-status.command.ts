import type { AuditAction } from '@contrataflow/types';
import {
  TenantActivated,
  TenantDeactivated,
  TenantOffboarded,
  TenantSuspended,
} from '@contrataflow/validation';
import type { DomainEventDraft } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditChange, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runAsPlatformOperator } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import type { FirstAdminInvitation } from '#shared/tenancy/tenant-seeding.js';

import {
  PLATFORM_TRANSACTIONS,
  TENANCY_CLOCK,
  TENANT_ADMIN_REPOSITORY,
  TENANT_STATUS_CACHE,
} from './ports.js';
import type {
  PlatformTransactions,
  TenancyClock,
  TenantAdminRepository,
  TenantStatusCachePort,
} from './ports.js';
import { ProvisioningPlan } from './provisioning-plan.js';
import {
  countStatusChange,
  invalidTransition,
  pendingStepsError,
  tenantNotFound,
} from './tenancy-support.js';
import type { PlatformActionOptions } from './tenancy-support.js';
import { pendingSteps } from '../domain/seeding-plan.js';
import { canTransition, transition } from '../domain/tenant.js';
import type { Tenant, TenantAction } from '../domain/tenant.js';

export type TenantRef = { readonly id: string } | { readonly slug: string };

export interface ChangeTenantStatusRequest extends PlatformActionOptions {
  readonly tenant: TenantRef;
  readonly action: TenantAction;
  /** `If-Match` (PLT-04/05); `null` na CLI, que age sobre a versão lida. */
  readonly expectedVersion: number | null;
  /** Suspensão e encerramento (RN-TEN-11/13). */
  readonly reason?: string;
  /** Encerramento: fim do prazo de leitura/exportação (padrão: 90 dias). */
  readonly offboardingEndsAt?: Date;
}

export interface ChangeTenantStatusResult {
  readonly tenant: Tenant;
  /** Convite do primeiro administrador, enviado na primeira ativação (RN-TEN-08). */
  readonly invitation: FirstAdminInvitation | null;
}

const AUDIT_ACTIONS: Readonly<Record<TenantAction, AuditAction>> = {
  ACTIVATE: 'tenant.activate',
  SUSPEND: 'tenant.suspend',
  // Lacuna (1) da story: encerramento e desativação compartilham `tenant.deactivate`,
  // distinguidos por `metadata.toStatus`.
  OFFBOARD: 'tenant.deactivate',
  DEACTIVATE: 'tenant.deactivate',
};

function eventOf(action: TenantAction, tenant: Tenant): DomainEventDraft {
  const base = { aggregateId: tenant.id };
  switch (action) {
    case 'ACTIVATE':
      return TenantActivated.of({ ...base, payload: { tenantId: tenant.id } });
    case 'SUSPEND':
      return TenantSuspended.of({ ...base, payload: { tenantId: tenant.id } });
    case 'OFFBOARD':
      return TenantOffboarded.of({
        ...base,
        payload: {
          tenantId: tenant.id,
          offboardingEndsAt: tenant.offboardingEndsAt?.toISOString() ?? null,
        },
      });
    case 'DEACTIVATE':
      return TenantDeactivated.of({ ...base, payload: { tenantId: tenant.id } });
  }
}

/**
 * `ActivateTenantCommand`/`SuspendTenantCommand`/`OffboardTenantCommand`/`DeactivateTenantCommand`
 * (US-099 · RN-TEN-08..13): uma transação na conexão de plataforma com a mudança de status
 * (versionada), a auditoria `tenant.*` com `actorType = PLATFORM_OPERATOR` no tenant afetado e o
 * evento `Tenant*`. Depois do commit, remove o status do cache (efeito em todas as instâncias em
 * até 60 s — RN-TEN-11) e, na primeira ativação, envia o convite do primeiro administrador.
 */
@Injectable()
export class ChangeTenantStatusCommand {
  private readonly logger = new Logger('Tenancy');

  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    @Inject(TENANT_STATUS_CACHE) private readonly statusCache: TenantStatusCachePort,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(TENANCY_CLOCK) private readonly clock: TenancyClock,
    private readonly plan: ProvisioningPlan,
  ) {}

  async execute(request: ChangeTenantStatusRequest): Promise<ChangeTenantStatusResult> {
    const current = await this.load(request.tenant);
    const { action } = request;
    if (request.expectedVersion !== null && request.expectedVersion !== current.version) {
      throw new VersionConflictError({
        aggregateType: 'Tenant',
        aggregateId: current.id,
        expectedVersion: request.expectedVersion,
      });
    }
    if (!canTransition(current.status, action)) throw invalidTransition(action, current.status);
    if (action === 'ACTIVATE' && current.status === 'PROVISIONING') {
      const checklist = await this.plan.checklist(this.plan.contextOf(current, null, this.clock()));
      if (!checklist.complete) throw pendingStepsError(pendingSteps(checklist));
    }

    const now = this.clock();
    const patch = transition(current, action, {
      now,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.offboardingEndsAt === undefined
        ? {}
        : { offboardingEndsAt: request.offboardingEndsAt }),
    });
    const updated = await runAsPlatformOperator(
      { userId: request.operator.id, name: request.operator.name, tenantId: current.id },
      () =>
        this.platform.run('TENANT_LIFECYCLE', async (tx) => {
          const tenant = await this.tenants.updateLifecycle(
            tx,
            current.id,
            current.version,
            patch,
            now,
          );
          await this.audit.record(tx, {
            action: AUDIT_ACTIONS[action],
            entityType: 'Tenant',
            entityId: tenant.id,
            changes: changesOf(current, tenant),
            metadata: {
              slug: tenant.slug,
              fromStatus: current.status,
              toStatus: tenant.status,
              channel: request.channel,
              ...(request.reason === undefined ? {} : { reason: request.reason }),
              ...(request.runId === undefined ? {} : { runId: request.runId }),
            },
          });
          await this.outbox.record(tx, eventOf(action, tenant));
          return tenant;
        }),
    );

    await this.statusCache.invalidate(updated.id);
    countStatusChange(current.status, updated.status, request.channel);
    this.logger.log(
      {
        event: 'tenant.status_changed',
        tenantId: updated.id,
        from: current.status,
        to: updated.status,
        channel: request.channel,
        hasReason: request.reason !== undefined,
      },
      'tenant.status_changed',
    );

    const invitation =
      action === 'ACTIVATE' && current.status === 'PROVISIONING'
        ? await this.dispatchInvitation(updated.id)
        : null;
    return { tenant: updated, invitation };
  }

  /** RN-TEN-08: só com o tenant `ACTIVE`, depois do commit; falha de fila não desfaz a ativação. */
  async dispatchInvitation(tenantId: string): Promise<FirstAdminInvitation | null> {
    const port = this.plan.invitation();
    if (!port) return null;
    try {
      const invitation = await port.dispatch(tenantId);
      if (invitation && !invitation.invitationDispatched) this.warnDispatchFailed(tenantId);
      return invitation;
    } catch (error) {
      this.warnDispatchFailed(tenantId, error);
      return port.describe(tenantId).catch(() => null);
    }
  }

  private warnDispatchFailed(tenantId: string, error?: unknown): void {
    this.logger.warn(
      {
        event: 'tenant.invitation_dispatch_failed',
        tenantId,
        ...(error === undefined ? {} : { cause: error instanceof Error ? error.name : 'unknown' }),
      },
      'tenant.invitation_dispatch_failed',
    );
  }

  private async load(ref: TenantRef): Promise<Tenant> {
    const tenant = await this.platform.read('TENANT_LIFECYCLE', (tx) =>
      'id' in ref ? this.tenants.findById(tx, ref.id) : this.tenants.findBySlug(tx, ref.slug),
    );
    if (!tenant) throw tenantNotFound();
    return tenant;
  }
}

/** Só o que mudou; o motivo de suspensão fica fora de `changes` (vai em `metadata.reason`). */
function changesOf(before: Tenant, after: Tenant): AuditChange[] {
  const changes: AuditChange[] = [{ path: 'status', old: before.status, new: after.status }];
  const dates = [
    'activatedAt',
    'suspendedAt',
    'offboardingStartedAt',
    'offboardingEndsAt',
    'deactivatedAt',
  ] as const;
  for (const field of dates) {
    const old = before[field]?.toISOString() ?? null;
    const next = after[field]?.toISOString() ?? null;
    if (old !== next) changes.push({ path: field, old, new: next });
  }
  return changes;
}
