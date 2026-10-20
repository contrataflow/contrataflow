import { TENANT_COMPLETE_STEP, TENANT_RECORD_STEP } from '@contrataflow/types';
import type { ProvisionTenant } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';

import { runAsSystem } from '#shared/context/request-context.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type {
  FirstAdminInvitationPort,
  TenantSeedContext,
  TenantSeeder,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { PLATFORM_TRANSACTIONS, TENANT_ADMIN_REPOSITORY } from './ports.js';
import type { PlatformTransactions, TenantAdminRepository } from './ports.js';
import { checklistOf, orderSeeders } from '../domain/seeding-plan.js';
import type { ChecklistStep, ProvisioningChecklist } from '../domain/seeding-plan.js';
import type { Tenant } from '../domain/tenant.js';

/** Nome do ator `SYSTEM` das etapas (`AuditLog.actorName` das auditorias dos seeders). */
export const PROVISIONING_ACTOR = 'Provisionamento de tenant';

/**
 * Plano de provisionamento (US-099 · RN-TEN-06/07): seeders registrados pelos módulos donos em
 * ordem topológica — calculada na subida, para que ciclo ou dependência ausente derrube o boot — e
 * o checklist calculado a partir do banco (`verify()` de cada etapa).
 */
@Injectable()
export class ProvisioningPlan implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');
  private ordered: readonly TenantSeeder[] | null = null;

  constructor(
    private readonly registry: TenantSeederRegistry,
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
  ) {}

  onApplicationBootstrap(): void {
    this.ordered = orderSeeders(this.registry.all());
    this.logger.log(
      {
        event: 'tenant.seeders_registered',
        seeders: this.ordered.map((seeder) => `${seeder.key}@${seeder.version}`),
      },
      'tenant.seeders_registered',
    );
  }

  /** Seeders na ordem de execução. */
  seeders(): readonly TenantSeeder[] {
    this.ordered ??= orderSeeders(this.registry.all());
    return this.ordered;
  }

  invitation(): FirstAdminInvitationPort | null {
    return this.registry.firstAdminInvitation();
  }

  /** Versões aplicadas, para `metadata.seedVersions` de `tenant.provision`. */
  seedVersions(): Record<string, string> {
    return Object.fromEntries(this.seeders().map((seeder) => [seeder.key, seeder.version]));
  }

  contextOf(tenant: Tenant, request: ProvisionTenant | null, now: Date): TenantSeedContext {
    return { tenantId: tenant.id, slug: tenant.slug, now, request };
  }

  /** Executa `fn` como o ator `SYSTEM` no tenant (seeders abrem a própria `TenantTransaction`). */
  inSeedScope<T>(tenantId: string, correlationId: string | undefined, fn: () => Promise<T>) {
    return runAsSystem(
      {
        name: PROVISIONING_ACTOR,
        tenantId,
        ...(correlationId === undefined ? {} : { correlationId }),
      },
      fn,
    );
  }

  verify(seeder: TenantSeeder, ctx: TenantSeedContext, correlationId?: string) {
    return this.inSeedScope<TenantSeedStatus>(ctx.tenantId, correlationId, () =>
      seeder.verify(ctx),
    );
  }

  /** RN-TEN-06: checklist completo, do registro do tenant à conclusão. */
  async checklist(ctx: TenantSeedContext, correlationId?: string): Promise<ProvisioningChecklist> {
    const steps: ChecklistStep[] = [{ key: TENANT_RECORD_STEP, status: 'DONE', version: null }];
    for (const seeder of this.seeders()) {
      const status = await this.verify(seeder, ctx, correlationId);
      steps.push({
        key: seeder.key,
        status: status.status,
        version: seeder.version,
        ...(status.details === undefined ? {} : { details: status.details }),
      });
    }
    const recorded = await this.platform.read('TENANT_LIFECYCLE', (tx) =>
      this.tenants.provisionRecorded(tx, ctx.tenantId),
    );
    steps.push({ key: TENANT_COMPLETE_STEP, status: recorded ? 'DONE' : 'PENDING', version: null });
    return checklistOf(steps);
  }
}
