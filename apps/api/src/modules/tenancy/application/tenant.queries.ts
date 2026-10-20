import { Inject, Injectable } from '@nestjs/common';

import type { FirstAdminInvitation } from '#shared/tenancy/tenant-seeding.js';

import { ChangeTenantStatusCommand } from './change-tenant-status.command.js';
import type { TenantRef } from './change-tenant-status.command.js';
import { PLATFORM_TRANSACTIONS, TENANCY_CLOCK, TENANT_ADMIN_REPOSITORY } from './ports.js';
import type {
  PlatformTransactions,
  TenancyClock,
  TenantAdminRepository,
  TenantListFilter,
  TenantPage,
} from './ports.js';
import { ProvisioningPlan } from './provisioning-plan.js';
import { invalidState, tenantNotFound } from './tenancy-support.js';
import type { ProvisioningChecklist } from '../domain/seeding-plan.js';
import type { Tenant } from '../domain/tenant.js';

/** `ListTenantsQuery` (PLT-02 · FA-03): só metadados, nunca dados de negócio. */
@Injectable()
export class ListTenantsQuery {
  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
  ) {}

  execute(filter: TenantListFilter): Promise<TenantPage> {
    return this.platform.read('TENANT_ENUMERATION', (tx) => this.tenants.list(tx, filter));
  }
}

export interface TenantDetail {
  readonly tenant: Tenant;
  readonly provisioning: ProvisioningChecklist;
}

/** `GetTenantQuery` (PLT-03 · `tenant:status`): dados e checklist calculado (só contagens). */
@Injectable()
export class GetTenantQuery {
  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    @Inject(TENANCY_CLOCK) private readonly clock: TenancyClock,
    private readonly plan: ProvisioningPlan,
  ) {}

  async execute(ref: TenantRef): Promise<TenantDetail> {
    const tenant = await this.platform.read('TENANT_LIFECYCLE', (tx) =>
      'id' in ref ? this.tenants.findById(tx, ref.id) : this.tenants.findBySlug(tx, ref.slug),
    );
    if (!tenant) throw tenantNotFound();
    const provisioning = await this.plan.checklist(this.plan.contextOf(tenant, null, this.clock()));
    return { tenant, provisioning };
  }
}

/**
 * `ResendFirstAdminInvitationCommand` (FA-07): repete o envio do convite do primeiro administrador
 * quando a fila falhou ou o convite expirou sem aceite — só com o tenant `ACTIVE` (RN-TEN-08).
 */
@Injectable()
export class ResendFirstAdminInvitationCommand {
  constructor(
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    private readonly lifecycle: ChangeTenantStatusCommand,
  ) {}

  async execute(slug: string): Promise<FirstAdminInvitation | null> {
    const tenant = await this.platform.read('TENANT_LIFECYCLE', (tx) =>
      this.tenants.findBySlug(tx, slug),
    );
    if (!tenant) throw tenantNotFound();
    if (tenant.status !== 'ACTIVE') throw invalidState('reenviar o convite', tenant.status);
    return this.lifecycle.dispatchInvitation(tenant.id);
  }
}
