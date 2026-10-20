import { Inject, Injectable } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { newId } from '#shared/database/ids.js';
import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { ORGANIZATION_REPOSITORY, ORGANIZATION_TRANSACTIONS } from './organization-ports.js';
import type { OrganizationRepository, OrganizationTransactions } from './organization-ports.js';
import { PLATFORM_TRANSACTIONS, TENANT_ADMIN_REPOSITORY } from './ports.js';
import type { PlatformTransactions, TenantAdminRepository } from './ports.js';
import { createOrganization } from '../domain/organization.js';

/**
 * Seeder `tenancy.primaryOrganization` (US-099 · US-101 · RN-TEN-04): cria o órgão principal do
 * `tenant.json` (`primaryOrganization`) na `TenantTransaction` do tenant novo — idempotente por
 * CNPJ — e aponta `tenants.primary_organization_id` para ele pela plataforma (`tenants` é tabela de
 * plataforma). Sem o pedido (`ctx.request` nulo) não cria nada; não se aplica a tenants existentes.
 * Audita `organization.create` como `SYSTEM`; não publica `OrganizationCreated` (o
 * `TenantProvisioned` já carrega o `primaryOrganizationId`).
 */
@Injectable()
export class PrimaryOrganizationSeeder implements TenantSeeder {
  readonly key = 'tenancy.primaryOrganization';
  readonly module = 'tenancy';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = false;

  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: OrganizationRepository,
    @Inject(ORGANIZATION_TRANSACTIONS) private readonly transactions: OrganizationTransactions,
    @Inject(TENANT_ADMIN_REPOSITORY) private readonly tenants: TenantAdminRepository,
    @Inject(PLATFORM_TRANSACTIONS) private readonly platform: PlatformTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const input = ctx.request?.primaryOrganization;
    if (!input) return { created: 0 };

    const { organizationId, created } = await this.transactions.run(async (tx) => {
      const existing = await this.organizations.findByCnpj(tx, input.cnpj);
      if (existing) return { organizationId: existing.id, created: 0 };
      const draft = createOrganization(input, {
        id: newId(),
        tenantId: ctx.tenantId,
        now: ctx.now,
        userId: null,
      });
      await this.organizations.insert(tx, draft);
      await this.audit.record(tx, {
        action: 'organization.create',
        entityType: 'Organization',
        entityId: draft.id,
        changes: ['name', 'shortName', 'cnpj', 'type'].map((path) => ({
          path,
          old: null,
          new: draft[path as 'name' | 'shortName' | 'cnpj' | 'type'],
        })),
        metadata: { shortName: draft.shortName, seeded: true, principal: true },
      });
      return { organizationId: draft.id, created: 1 };
    });

    await this.platform.run('TENANT_PROVISIONING', (tx) =>
      this.tenants.setPrimaryOrganization(tx, ctx.tenantId, organizationId),
    );
    return { created, skipped: 1 - created };
  }

  async verify(ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const tenant = await this.platform.read('TENANT_PROVISIONING', (tx) =>
      this.tenants.findById(tx, ctx.tenantId),
    );
    const done = (tenant?.primaryOrganizationId ?? null) !== null;
    return { status: done ? 'DONE' : 'PENDING', details: { organizations: done ? 1 : 0 } };
  }
}
