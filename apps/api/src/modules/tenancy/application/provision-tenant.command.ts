import { createHash } from 'node:crypto';

import { TENANT_COMPLETE_STEP, TENANT_RECORD_STEP } from '@contrataflow/types';
import { TenantProvisioned, maskEmail } from '@contrataflow/validation';
import type { ProvisionTenant } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { currentRequestContext, runAsPlatformOperator } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import { OUTBOX_WRITER } from '#shared/outbox/outbox-writer.js';
import type { OutboxWriterPort } from '#shared/outbox/outbox-writer.js';
import type {
  FirstAdminInvitation,
  TenantSeedContext,
  TenantSeeder,
} from '#shared/tenancy/tenant-seeding.js';

import { ChangeTenantStatusCommand } from './change-tenant-status.command.js';
import {
  PLATFORM_TRANSACTIONS,
  TENANCY_CLOCK,
  TENANT_ADMIN_REPOSITORY,
  TenantSlugTakenError,
} from './ports.js';
import type { PlatformTransactions, TenancyClock, TenantAdminRepository } from './ports.js';
import { ProvisioningPlan } from './provisioning-plan.js';
import { errorCodeOf, recordProvisioningDuration, slugTaken } from './tenancy-support.js';
import type { PlatformActionOptions } from './tenancy-support.js';
import { checklistOf } from '../domain/seeding-plan.js';
import type { ChecklistStep, ProvisioningChecklist } from '../domain/seeding-plan.js';
import type { Tenant } from '../domain/tenant.js';

export interface ProvisionTenantRequest extends PlatformActionOptions {
  readonly input: ProvisionTenant;
  /** `Idempotency-Key` da API (`metadata.idempotencyKey`); `null` na CLI. */
  readonly idempotencyKey: string | null;
}

/** FA-01: impressão do pedido — mesmo slug, CNPJ do órgão principal e e-mail do administrador. */
export function fingerprintOf(input: ProvisionTenant): string {
  return createHash('sha256')
    .update([input.slug, input.primaryOrganization.cnpj, input.firstAdmin.email].join('\n'))
    .digest('hex');
}

/** Só retoma o tenant em `PROVISIONING` criado pelo MESMO pedido (outro CNPJ/e-mail → 409). */
function isSameRequest(existing: Tenant, input: ProvisionTenant): boolean {
  return (
    existing.status === 'PROVISIONING' && existing.provisioningFingerprint === fingerprintOf(input)
  );
}

export type PlannedStepAction = 'CREATE' | 'SKIP' | 'RUN';

export interface ProvisioningDryRun {
  readonly kind: 'planned';
  /** Tenant em `PROVISIONING` que seria retomado, ou `null` (seria criado). */
  readonly existingTenantId: string | null;
  readonly steps: readonly { readonly key: string; readonly action: PlannedStepAction }[];
}

export interface ProvisioningOutcome {
  readonly kind: 'complete' | 'incomplete';
  readonly tenant: Tenant;
  readonly checklist: ProvisioningChecklist;
  readonly firstAdmin: FirstAdminInvitation | null;
  /** Etapa que falhou (incompleto), com o código do erro. */
  readonly failedStep?: string;
  readonly errorCode?: string;
  readonly error?: unknown;
}

/**
 * `ProvisionTenantCommand` (US-099 · fluxo principal e FA-01/02/11): checklist de etapas
 * idempotentes e retomáveis — registro do tenant (`SystemDbService`), seeders dos módulos donos
 * (cada um na própria `TenantTransaction` do tenant novo, como ator `SYSTEM`), conclusão
 * (`tenant.provision` + `TenantProvisioned` numa transação) e, por padrão, a ativação com o
 * convite. Falha numa etapa preserva o que já foi feito: o resultado vem `incomplete` e a
 * reexecução com o mesmo slug, CNPJ e e-mail continua de onde parou. CLI e API usam este mesmo caso
 * de uso (RN-TEN-17).
 */
@Injectable()
export class ProvisionTenantCommand {
  private readonly logger = new Logger('Tenancy');

  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(TENANCY_CLOCK) private readonly clock: TenancyClock,
    private readonly plan: ProvisioningPlan,
    private readonly lifecycle: ChangeTenantStatusCommand,
  ) {}

  /** FA-11: valida e mostra o plano, sem gravar. */
  async dryRun(input: ProvisionTenant): Promise<ProvisioningDryRun> {
    const existing = await this.platform.read('TENANT_PROVISIONING', (tx) =>
      this.tenants.findBySlug(tx, input.slug),
    );
    if (existing && !isSameRequest(existing, input)) throw slugTaken(input.slug);
    if (!existing) {
      return {
        kind: 'planned',
        existingTenantId: null,
        steps: [
          { key: TENANT_RECORD_STEP, action: 'CREATE' },
          ...this.plan.seeders().map((seeder) => ({ key: seeder.key, action: 'RUN' as const })),
          { key: TENANT_COMPLETE_STEP, action: 'RUN' },
        ],
      };
    }
    const checklist = await this.plan.checklist(this.plan.contextOf(existing, input, this.clock()));
    return {
      kind: 'planned',
      existingTenantId: existing.id,
      steps: checklist.steps.map((step) => ({
        key: step.key,
        action: step.status === 'DONE' ? 'SKIP' : 'RUN',
      })),
    };
  }

  async execute(request: ProvisionTenantRequest): Promise<ProvisioningOutcome> {
    const { input, operator, channel } = request;
    const startedAt = performance.now();
    const correlationId = currentRequestContext()?.correlationId;
    this.logger.log(
      {
        event: 'tenant.provision.started',
        slug: input.slug,
        channel,
        operatorId: operator.id,
        correlationId: correlationId ?? null,
      },
      'tenant.provision.started',
    );

    const tenant = await this.tenantRecord(request);
    const ctx = this.plan.contextOf(tenant, input, this.clock());

    for (const seeder of this.plan.seeders()) {
      const failure = await this.runStep(seeder, ctx, correlationId);
      if (failure) {
        return this.incomplete(request, tenant, ctx, seeder.key, failure, startedAt);
      }
    }

    let completed: Tenant;
    try {
      completed = await this.complete(request, tenant, startedAt);
    } catch (error) {
      return this.incomplete(request, tenant, ctx, TENANT_COMPLETE_STEP, error, startedAt);
    }

    let firstAdmin: FirstAdminInvitation | null;
    if (input.activate && completed.status === 'PROVISIONING') {
      const activated = await this.lifecycle.execute({
        tenant: { id: completed.id },
        action: 'ACTIVATE',
        expectedVersion: null,
        operator,
        channel,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
      });
      completed = activated.tenant;
      firstAdmin = activated.invitation;
    } else {
      firstAdmin = (await this.plan.invitation()?.describe(completed.id)) ?? null;
    }
    const checklist = await this.plan.checklist(ctx, correlationId);
    recordProvisioningDuration((performance.now() - startedAt) / 1000, 'complete');
    return { kind: 'complete', tenant: completed, checklist, firstAdmin };
  }

  /**
   * Etapa `tenancy.tenantRecord`: cria o tenant em `PROVISIONING` ou retoma o existente (FA-01).
   * Slug usado por outro tenant (ativo, desativado ou com dados divergentes) → 409, auditado na
   * auditoria de plataforma (RN-TEN-15).
   */
  private async tenantRecord(request: ProvisionTenantRequest): Promise<Tenant> {
    const { input } = request;
    const existing = await this.platform.read('TENANT_PROVISIONING', (tx) =>
      this.tenants.findBySlug(tx, input.slug),
    );
    if (existing) {
      if (!isSameRequest(existing, input)) return this.rejectSlug(request);
      this.logger.log(
        { event: 'tenant.provision.resumed', tenantId: existing.id, slug: existing.slug },
        'tenant.provision.resumed',
      );
      return existing;
    }

    const now = this.clock();
    const stepStartedAt = performance.now();
    const draft: Tenant = {
      id: newId(),
      slug: input.slug,
      name: input.name,
      legalName: input.legalName ?? null,
      type: input.type,
      status: 'PROVISIONING',
      stateCode: input.stateCode,
      ibgeCityCode: input.ibgeCityCode ?? null,
      timezone: input.timezone,
      locale: input.locale,
      plan: input.plan,
      primaryOrganizationId: null,
      activatedAt: null,
      suspendedAt: null,
      suspensionReason: null,
      deactivatedAt: null,
      offboardingStartedAt: null,
      offboardingEndsAt: null,
      provisioningFingerprint: fingerprintOf(input),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    try {
      const tenant = await this.platform.run('TENANT_PROVISIONING', (tx) =>
        this.tenants.insert(tx, draft),
      );
      this.logStep(tenant.id, TENANT_RECORD_STEP, null, 1, 0, stepStartedAt);
      return tenant;
    } catch (error) {
      // Dois provisionamentos simultâneos do mesmo slug: o índice único decide (Concorrência).
      if (error instanceof TenantSlugTakenError) return this.rejectSlug(request);
      throw error;
    }
  }

  private async rejectSlug(request: ProvisionTenantRequest): Promise<never> {
    // Auditoria de plataforma (`tenantId` nulo): a falha é anterior a qualquer tenant (RN-TEN-15).
    await runAsPlatformOperator(
      { userId: request.operator.id, name: request.operator.name, tenantId: null },
      () =>
        this.audit.recordStandalone({
          action: 'tenant.provision',
          result: 'FAILURE',
          reasonCode: 'TENANT_SLUG_TAKEN',
          metadata: {
            slug: request.input.slug,
            channel: request.channel,
            failedStep: TENANT_RECORD_STEP,
            errorCode: 'TENANT_SLUG_TAKEN',
            ...this.executionMetadata(request),
          },
        }),
    ).catch((error: unknown) => {
      this.logger.warn(
        { event: 'tenant.provision.audit_failed', cause: errorCodeOf(error) },
        'tenant.provision.audit_failed',
      );
    });
    throw slugTaken(request.input.slug);
  }

  /** Executa a etapa se ainda `PENDING`; devolve o erro (sem lançar) quando ela falha. */
  private async runStep(
    seeder: TenantSeeder,
    ctx: TenantSeedContext,
    correlationId: string | undefined,
  ): Promise<unknown> {
    const startedAt = performance.now();
    try {
      const before = await this.plan.verify(seeder, ctx, correlationId);
      if (before.status === 'DONE') {
        this.logStep(ctx.tenantId, seeder.key, seeder.version, 0, 0, startedAt);
        return null;
      }
      const result = await this.plan.inSeedScope(ctx.tenantId, correlationId, () =>
        seeder.seed(ctx),
      );
      this.logStep(
        ctx.tenantId,
        seeder.key,
        seeder.version,
        result.created,
        result.skipped ?? 0,
        startedAt,
      );
      return null;
    } catch (error) {
      this.logger.warn(
        {
          event: 'tenant.provision.step_failed',
          tenantId: ctx.tenantId,
          step: seeder.key,
          errorCode: errorCodeOf(error),
        },
        'tenant.provision.step_failed',
      );
      return error ?? new Error('Falha sem detalhe na etapa.');
    }
  }

  /** Etapa `tenancy.complete`: auditoria `tenant.provision` e `TenantProvisioned`, uma única vez. */
  private async complete(
    request: ProvisionTenantRequest,
    tenant: Tenant,
    startedAt: number,
  ): Promise<Tenant> {
    const ctx = this.plan.contextOf(tenant, request.input, this.clock());
    const checklist = await this.plan.checklist(ctx);
    const pending = checklist.steps.filter(
      (step) => step.status !== 'DONE' && step.key !== TENANT_COMPLETE_STEP,
    );
    if (pending.length > 0) {
      throw new Error(`Etapas pendentes: ${pending.map((step) => step.key).join(', ')}.`);
    }
    return runAsPlatformOperator(
      { userId: request.operator.id, name: request.operator.name, tenantId: tenant.id },
      () =>
        this.platform.run('TENANT_PROVISIONING', async (tx) => {
          const current = (await this.tenants.findById(tx, tenant.id)) ?? tenant;
          if (await this.tenants.provisionRecorded(tx, tenant.id)) return current;
          await this.audit.record(tx, {
            action: 'tenant.provision',
            entityType: 'Tenant',
            entityId: tenant.id,
            metadata: {
              slug: tenant.slug,
              channel: request.channel,
              seedVersions: this.plan.seedVersions(),
              steps: checklist.steps.map((step) => step.key),
              durationMs: Math.round(performance.now() - startedAt),
              ...this.executionMetadata(request),
            },
          });
          await this.outbox.record(
            tx,
            TenantProvisioned.of({
              aggregateId: tenant.id,
              payload: {
                tenantId: tenant.id,
                slug: tenant.slug,
                primaryOrganizationId: current.primaryOrganizationId,
              },
            }),
          );
          await this.tenants.markProvisioned(tx, tenant.id);
          this.logStep(tenant.id, TENANT_COMPLETE_STEP, null, 1, 0, startedAt);
          return current;
        }),
    );
  }

  /** Resultado incompleto: auditoria `FAILURE` no tenant (melhor esforço) e o checklist possível. */
  private async incomplete(
    request: ProvisionTenantRequest,
    tenant: Tenant,
    ctx: TenantSeedContext,
    failedStep: string,
    error: unknown,
    startedAt: number,
  ): Promise<ProvisioningOutcome> {
    const errorCode = errorCodeOf(error);
    await runAsPlatformOperator(
      { userId: request.operator.id, name: request.operator.name, tenantId: tenant.id },
      () =>
        this.platform.run('TENANT_PROVISIONING', (tx) =>
          this.audit.record(tx, {
            action: 'tenant.provision',
            result: 'FAILURE',
            reasonCode: errorCode,
            entityType: 'Tenant',
            entityId: tenant.id,
            metadata: {
              slug: tenant.slug,
              channel: request.channel,
              failedStep,
              errorCode,
              durationMs: Math.round(performance.now() - startedAt),
              ...this.executionMetadata(request),
            },
          }),
        ),
    ).catch(() => undefined);
    const checklist = await this.plan.checklist(ctx).catch(() => this.assumedChecklist(failedStep));
    recordProvisioningDuration((performance.now() - startedAt) / 1000, 'incomplete');
    return {
      kind: 'incomplete',
      tenant,
      checklist,
      firstAdmin: null,
      failedStep,
      errorCode,
      error,
    };
  }

  /** Banco fora do ar também no checklist: as etapas a partir da que falhou ficam `PENDING`. */
  private assumedChecklist(failedStep: string): ProvisioningChecklist {
    const keys = [
      ...this.plan.seeders().map((seeder) => ({ key: seeder.key, version: seeder.version })),
      { key: TENANT_COMPLETE_STEP, version: null },
    ];
    const failedAt = keys.findIndex((step) => step.key === failedStep);
    const steps: ChecklistStep[] = [
      { key: TENANT_RECORD_STEP, status: 'DONE', version: null },
      ...keys.map((step, index): ChecklistStep => ({
        key: step.key,
        status: index < failedAt ? 'DONE' : 'PENDING',
        version: step.version,
      })),
    ];
    return checklistOf(steps);
  }

  private executionMetadata(request: ProvisionTenantRequest): Record<string, string> {
    return {
      firstAdmin: maskEmail(request.input.firstAdmin.email),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.runId ? { runId: request.runId } : {}),
    };
  }

  private logStep(
    tenantId: string,
    step: string,
    version: string | null,
    created: number,
    skipped: number,
    startedAt: number,
  ): void {
    this.logger.log(
      {
        event: 'tenant.provision.step_completed',
        tenantId,
        step,
        version,
        created,
        skipped,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'tenant.provision.step_completed',
    );
  }
}
