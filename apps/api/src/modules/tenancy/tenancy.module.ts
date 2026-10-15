import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import { PlatformCache } from '#shared/cache/tenant-cache.js';
import { TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { ApplyTenantSeedersCommand } from './application/apply-tenant-seeders.command.js';
import { ChangeTenantStatusCommand } from './application/change-tenant-status.command.js';
import {
  PLATFORM_TRANSACTIONS,
  TENANCY_CLOCK,
  TENANT_ADMIN_REPOSITORY,
  TENANT_STATUS_CACHE,
} from './application/ports.js';
import { ProvisionTenantCommand } from './application/provision-tenant.command.js';
import { ProvisioningPlan } from './application/provisioning-plan.js';
import { TenancyFacade } from './application/tenancy.facade.js';
import {
  GetTenantQuery,
  ListTenantsQuery,
  ResendFirstAdminInvitationCommand,
} from './application/tenant.queries.js';
import {
  InMemoryPlatformTransactions,
  InMemoryTenantRepository,
} from './infrastructure/in-memory-tenant.repository.js';
import {
  PrismaTenantAdminRepository,
  SystemDbPlatformTransactions,
} from './infrastructure/prisma-tenant-admin.repository.js';
import { PrismaTenantRepository } from './infrastructure/prisma-tenant.repository.js';
import { TenantStatusCache } from './infrastructure/tenant-status.cache.js';
import { PlatformTenantsController } from './presentation/platform-tenants.controller.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): tenants em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `tenancy` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * `TenantStatusPort` do guard de tenant sobre `tenants` (US-087) com o `TenantStatusCache` de 30 s
 * (US-100) e o provisionamento e o ciclo de vida do tenant pela plataforma (US-099): PLT-01..05,
 * CLI `pnpm cf tenant:*` e o registro de seeders dos módulos donos (`TenantSeedingModule`). No modo
 * de identidade fake a mesma instância em memória serve o guard e os casos de uso.
 */
@Module({
  imports: [TenantSeedingModule],
  controllers: [PlatformTenantsController],
  providers: [
    TenancyFacade,
    ProvisioningPlan,
    ProvisionTenantCommand,
    ChangeTenantStatusCommand,
    ApplyTenantSeedersCommand,
    ResendFirstAdminInvitationCommand,
    ListTenantsQuery,
    GetTenantQuery,
    PrismaTenantRepository,
    PrismaTenantAdminRepository,
    SystemDbPlatformTransactions,
    { provide: InMemoryTenantRepository, useFactory: () => new InMemoryTenantRepository() },
    InMemoryPlatformTransactions,
    {
      provide: TENANT_ADMIN_REPOSITORY,
      inject: [APP_CONFIG, PrismaTenantAdminRepository, InMemoryTenantRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTenantAdminRepository,
        memory: InMemoryTenantRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: PLATFORM_TRANSACTIONS,
      inject: [APP_CONFIG, SystemDbPlatformTransactions, InMemoryPlatformTransactions],
      useFactory: (
        config: AppConfig,
        systemDb: SystemDbPlatformTransactions,
        memory: InMemoryPlatformTransactions,
      ) => (inMemory(config) ? memory : systemDb),
    },
    {
      provide: TenantStatusCache,
      inject: [APP_CONFIG, PrismaTenantRepository, InMemoryTenantRepository, PlatformCache],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTenantRepository,
        memory: InMemoryTenantRepository,
        cache: PlatformCache,
      ) => new TenantStatusCache(inMemory(config) ? memory : prisma, cache),
    },
    { provide: TENANT_STATUS_PORT, useExisting: TenantStatusCache },
    { provide: TENANT_STATUS_CACHE, useExisting: TenantStatusCache },
    { provide: TENANCY_CLOCK, useValue: () => new Date() },
  ],
  exports: [TenancyFacade, TENANT_STATUS_PORT],
})
export class TenancyModule {}
