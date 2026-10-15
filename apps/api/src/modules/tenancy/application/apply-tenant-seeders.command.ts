import { Inject, Injectable, Logger } from '@nestjs/common';

import { validationError } from '#shared/errors/api-error.js';

import { PLATFORM_TRANSACTIONS, TENANCY_CLOCK, TENANT_ADMIN_REPOSITORY } from './ports.js';
import type { PlatformTransactions, TenancyClock, TenantAdminRepository } from './ports.js';
import { ProvisioningPlan } from './provisioning-plan.js';
import { errorCodeOf, invalidState, tenantNotFound } from './tenancy-support.js';

export interface ApplyTenantSeedersRequest {
  readonly slug: string;
  /** Só este seeder (`--seeder <chave>`); padrão: todos os aplicáveis. */
  readonly seederKey?: string;
  readonly dryRun: boolean;
}

export interface AppliedSeeder {
  readonly key: string;
  readonly version: string;
  /** `APPLIED` (executado agora), `UP_TO_DATE` (já `DONE`), `PLANNED` (simulação), `FAILED`. */
  readonly result: 'APPLIED' | 'UP_TO_DATE' | 'PLANNED' | 'FAILED';
  readonly created?: number;
  readonly errorCode?: string;
}

/**
 * `ApplyTenantSeedersCommand` (US-099 · FA-08 · RM-07): aplica a um tenant existente os seeders com
 * `applyToExistingTenants = true` ainda `PENDING` — idempotentes e sem alterar dados existentes.
 * Cada seeder audita o que cria (ex.: `role.create`); falha de um não impede os seguintes.
 */
@Injectable()
export class ApplyTenantSeedersCommand {
  private readonly logger = new Logger('Tenancy');

  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    @Inject(TENANCY_CLOCK) private readonly clock: TenancyClock,
    private readonly plan: ProvisioningPlan,
  ) {}

  async execute(request: ApplyTenantSeedersRequest): Promise<AppliedSeeder[]> {
    const tenant = await this.platform.read('TENANT_LIFECYCLE', (tx) =>
      this.tenants.findBySlug(tx, request.slug),
    );
    if (!tenant) throw tenantNotFound();
    if (tenant.status === 'DEACTIVATED') throw invalidState('aplicar seeders', tenant.status);

    const applicable = this.plan
      .seeders()
      .filter((seeder) => seeder.applyToExistingTenants)
      .filter((seeder) => request.seederKey === undefined || seeder.key === request.seederKey);
    if (request.seederKey !== undefined && applicable.length === 0) {
      throw validationError([
        {
          field: 'seeder',
          code: 'INVALID_ENUM',
          message: 'Seeder inexistente ou não aplicável a tenants existentes.',
        },
      ]);
    }

    const ctx = this.plan.contextOf(tenant, null, this.clock());
    const results: AppliedSeeder[] = [];
    for (const seeder of applicable) {
      const base = { key: seeder.key, version: seeder.version };
      try {
        const status = await this.plan.verify(seeder, ctx);
        if (status.status === 'DONE') {
          results.push({ ...base, result: 'UP_TO_DATE' });
          continue;
        }
        if (request.dryRun) {
          results.push({ ...base, result: 'PLANNED' });
          continue;
        }
        const seeded = await this.plan.inSeedScope(tenant.id, undefined, () => seeder.seed(ctx));
        results.push({ ...base, result: 'APPLIED', created: seeded.created });
      } catch (error) {
        results.push({ ...base, result: 'FAILED', errorCode: errorCodeOf(error) });
      }
    }
    this.logger.log(
      {
        event: 'tenant.seeders_applied',
        tenantId: tenant.id,
        dryRun: request.dryRun,
        results: results.map((result) => `${result.key}:${result.result}`),
      },
      'tenant.seeders_applied',
    );
    return results;
  }
}
