import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { AccessFacade } from './application/access.facade.js';
import { DefaultRolesSeeder } from './application/default-roles.seeder.js';
import { ListPermissionsQuery } from './application/list-permissions.query.js';
import { ACCESS_CLOCK, ACCESS_TRANSACTIONS, ROLE_REPOSITORY } from './application/ports.js';
import { SeedDefaultRolesHandler } from './application/seed-default-roles.handler.js';
import {
  InMemoryAccessTransactions,
  PrismaAccessTransactions,
} from './infrastructure/access-transactions.js';
import { InMemoryRoleRepository } from './infrastructure/in-memory-role.repository.js';
import { PrismaRoleRepository } from './infrastructure/prisma-role.repository.js';
import { PermissionController } from './presentation/permission.controller.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): perfis em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `access` (DEC-040): outros módulos usam somente a fachada exportada. Dono do catálogo de
 * permissões (ROL-01) e dos perfis do tenant — seeder `access.defaultRoles` dos 15 perfis padrão
 * (US-094), registrado no checklist de provisionamento (US-099).
 */
@Module({
  imports: [TenantSeedingModule],
  controllers: [PermissionController],
  providers: [
    AccessFacade,
    ListPermissionsQuery,
    SeedDefaultRolesHandler,
    DefaultRolesSeeder,
    PrismaRoleRepository,
    InMemoryRoleRepository,
    PrismaAccessTransactions,
    InMemoryAccessTransactions,
    {
      provide: ROLE_REPOSITORY,
      inject: [APP_CONFIG, PrismaRoleRepository, InMemoryRoleRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaRoleRepository,
        memory: InMemoryRoleRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: ACCESS_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaAccessTransactions, InMemoryAccessTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaAccessTransactions,
        memory: InMemoryAccessTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: ACCESS_CLOCK, useValue: () => new Date() },
  ],
  exports: [AccessFacade],
})
export class AccessModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly defaultRoles: DefaultRolesSeeder,
  ) {}

  onModuleInit(): void {
    this.seeders.register(this.defaultRoles);
  }
}
