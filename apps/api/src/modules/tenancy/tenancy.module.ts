import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TENANT_STATUS_PORT } from '#shared/auth/ports.js';
import { PlatformCache } from '#shared/cache/tenant-cache.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { ApplyTenantSeedersCommand } from './application/apply-tenant-seeders.command.js';
import { ChangeTenantStatusCommand } from './application/change-tenant-status.command.js';
import { CreateOrganizationCommand } from './application/create-organization.command.js';
import {
  ORGANIZATION_CLOCK,
  ORGANIZATION_LOGO_PORT,
  ORGANIZATION_REPOSITORY,
  ORGANIZATION_TRANSACTIONS,
} from './application/organization-ports.js';
import {
  GetOrganizationQuery,
  ListOrganizationsQuery,
} from './application/organization.queries.js';
import {
  PLATFORM_TRANSACTIONS,
  TENANCY_CLOCK,
  TENANT_ADMIN_REPOSITORY,
  TENANT_STATUS_CACHE,
} from './application/ports.js';
import { PrimaryOrganizationSeeder } from './application/primary-organization.seeder.js';
import { ProvisionTenantCommand } from './application/provision-tenant.command.js';
import { ProvisioningPlan } from './application/provisioning-plan.js';
import {
  SETTINGS_CLOCK,
  SETTINGS_TRANSACTIONS,
  TENANT_SETTINGS_REPOSITORY,
} from './application/settings-ports.js';
import { GetPublicSettingsQuery, GetSettingsQuery } from './application/settings.queries.js';
import { TenancyFacade } from './application/tenancy.facade.js';
import { TenantSettingsSeeder } from './application/tenant-settings.seeder.js';
import {
  GetTenantQuery,
  ListTenantsQuery,
  ResendFirstAdminInvitationCommand,
} from './application/tenant.queries.js';
import { UpdateOrganizationCommand } from './application/update-organization.command.js';
import { UpdateSettingsCommand } from './application/update-settings.command.js';
import { SettingsRegistry } from './domain/settings-registry.js';
import {
  InMemoryOrganizationRepository,
  InMemoryOrganizationTransactions,
  RejectingLogoPort,
} from './infrastructure/in-memory-organization.repository.js';
import {
  InMemorySettingsTransactions,
  InMemoryTenantSettingsRepository,
} from './infrastructure/in-memory-tenant-settings.repository.js';
import {
  InMemoryPlatformTransactions,
  InMemoryTenantRepository,
} from './infrastructure/in-memory-tenant.repository.js';
import {
  PrismaOrganizationRepository,
  PrismaOrganizationTransactions,
} from './infrastructure/prisma-organization.repository.js';
import {
  PrismaTenantAdminRepository,
  SystemDbPlatformTransactions,
} from './infrastructure/prisma-tenant-admin.repository.js';
import {
  PrismaSettingsTransactions,
  PrismaTenantSettingsRepository,
} from './infrastructure/prisma-tenant-settings.repository.js';
import { PrismaTenantRepository } from './infrastructure/prisma-tenant.repository.js';
import { TenantStatusCache } from './infrastructure/tenant-status.cache.js';
import { OrganizationController } from './presentation/organization.controller.js';
import { PlatformTenantsController } from './presentation/platform-tenants.controller.js';
import { SettingsController } from './presentation/settings.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): tenants em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `tenancy` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * `TenantStatusPort` do guard de tenant sobre `tenants` (US-087) com o `TenantStatusCache` de 30 s
 * (US-100) e o provisionamento e o ciclo de vida do tenant pela plataforma (US-099): PLT-01..05,
 * CLI `pnpm cf tenant:*` e o registro de seeders dos módulos donos (`TenantSeedingModule`), e dono
 * dos órgãos do tenant (US-101: ORG-01..04 e o seeder do órgão principal; autorização e MFA vêm de
 * `access`/`identity` — exceção registrada em `tools/module-levels.json`). No modo
 * de identidade fake a mesma instância em memória serve o guard e os casos de uso.
 */
@Module({
  imports: [AccessModule, IdentityModule, TenantSeedingModule],
  controllers: [PlatformTenantsController, OrganizationController, SettingsController],
  providers: [
    TenancyFacade,
    ProvisioningPlan,
    ProvisionTenantCommand,
    ChangeTenantStatusCommand,
    ApplyTenantSeedersCommand,
    ResendFirstAdminInvitationCommand,
    ListTenantsQuery,
    GetTenantQuery,
    ListOrganizationsQuery,
    GetOrganizationQuery,
    CreateOrganizationCommand,
    UpdateOrganizationCommand,
    PrimaryOrganizationSeeder,
    GetSettingsQuery,
    GetPublicSettingsQuery,
    UpdateSettingsCommand,
    TenantSettingsSeeder,
    // Registro tipado de chaves (entities.md §6): chave duplicada entre módulos derruba o boot.
    { provide: SettingsRegistry, useFactory: () => new SettingsRegistry([SETTING_DEFINITIONS]) },
    PrismaTenantSettingsRepository,
    PrismaSettingsTransactions,
    InMemorySettingsTransactions,
    {
      provide: InMemoryTenantSettingsRepository,
      useFactory: () =>
        new InMemoryTenantSettingsRepository(() => currentRequestContext()?.tenantId ?? null),
    },
    {
      provide: TENANT_SETTINGS_REPOSITORY,
      inject: [APP_CONFIG, PrismaTenantSettingsRepository, InMemoryTenantSettingsRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTenantSettingsRepository,
        memory: InMemoryTenantSettingsRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: SETTINGS_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaSettingsTransactions, InMemorySettingsTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaSettingsTransactions,
        memory: InMemorySettingsTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: SETTINGS_CLOCK, useValue: () => new Date() },
    PrismaOrganizationRepository,
    PrismaOrganizationTransactions,
    InMemoryOrganizationTransactions,
    {
      provide: InMemoryOrganizationRepository,
      inject: [InMemoryTenantRepository],
      useFactory: (tenants: InMemoryTenantRepository) =>
        new InMemoryOrganizationRepository(tenants),
    },
    {
      provide: ORGANIZATION_REPOSITORY,
      inject: [APP_CONFIG, PrismaOrganizationRepository, InMemoryOrganizationRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaOrganizationRepository,
        memory: InMemoryOrganizationRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: ORGANIZATION_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaOrganizationTransactions, InMemoryOrganizationTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaOrganizationTransactions,
        memory: InMemoryOrganizationTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    // Anexos (US-068) ainda não existem: até lá nenhum `logoAttachmentId` é aceito (RN-TEN-42).
    { provide: ORGANIZATION_LOGO_PORT, useValue: new RejectingLogoPort() },
    { provide: ORGANIZATION_CLOCK, useValue: () => new Date() },
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
export class TenancyModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly primaryOrganization: PrimaryOrganizationSeeder,
    private readonly settings: TenantSettingsSeeder,
  ) {}

  /** Seeders `tenancy.primaryOrganization` e `tenancy.settings` no checklist (US-099). */
  onModuleInit(): void {
    this.seeders.register(this.primaryOrganization);
    this.seeders.register(this.settings);
  }
}
