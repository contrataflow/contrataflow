import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  MembershipReferences,
  MembershipReferencesModule,
} from '#shared/auth/membership-references.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { AccessFacade } from './application/access.facade.js';
import { DefaultRolesSeeder } from './application/default-roles.seeder.js';
import { ListPermissionsQuery } from './application/list-permissions.query.js';
import { MembershipAccessProvider } from './application/membership-access.provider.js';
import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_COUNTER,
  ROLE_ASSIGNMENT_WRITER,
  ROLE_REPOSITORY,
} from './application/ports.js';
import { RoleActorResolver } from './application/role-actor.js';
import {
  CreateRoleCommand,
  DeactivateRoleCommand,
  DuplicateRoleCommand,
  RoleCommandSupport,
  UpdateRoleCommand,
  UpdateRolePermissionsCommand,
} from './application/role.commands.js';
import { GetRoleQuery, ListRolesQuery } from './application/role.queries.js';
import { SeedDefaultRolesHandler } from './application/seed-default-roles.handler.js';
import {
  InMemoryAccessTransactions,
  PrismaAccessTransactions,
} from './infrastructure/access-transactions.js';
import { InMemoryRoleRepository } from './infrastructure/in-memory-role.repository.js';
import {
  NoRoleAssignmentsCounter,
  PrismaRoleRepository,
} from './infrastructure/prisma-role.repository.js';
import {
  InMemoryRoleAssignmentWriter,
  PrismaRoleAssignmentWriter,
} from './infrastructure/role-assignment.writer.js';
import { PermissionController } from './presentation/permission.controller.js';
import { RoleController } from './presentation/role.controller.js';
import { IdentityModule } from '../identity/identity.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): perfis em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `access` (DEC-040): outros módulos usam somente a fachada exportada. Dono do catálogo de
 * permissões (ROL-01) e dos perfis do tenant — seeder `access.defaultRoles` dos 15 perfis padrão
 * (US-094), registrado no checklist de provisionamento (US-099), e gestão de perfis e matriz
 * (ROL-02..08 · US-095; MFA via `IdentityFacade.mfaPolicy` — exceção de nível em DEC-041).
 */
@Module({
  imports: [TenantSeedingModule, IdentityModule, MembershipReferencesModule],
  controllers: [PermissionController, RoleController],
  providers: [
    AccessFacade,
    ListPermissionsQuery,
    RoleActorResolver,
    RoleCommandSupport,
    ListRolesQuery,
    GetRoleQuery,
    CreateRoleCommand,
    UpdateRoleCommand,
    UpdateRolePermissionsCommand,
    DuplicateRoleCommand,
    DeactivateRoleCommand,
    // `role_assignments` nasce com a US-096, que troca este adaptador pela contagem real.
    { provide: ROLE_ASSIGNMENT_COUNTER, useClass: NoRoleAssignmentsCounter },
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
    // US-091: autorização e perfil inicial do convite pela porta `MembershipReferences`.
    PrismaRoleAssignmentWriter,
    InMemoryRoleAssignmentWriter,
    {
      provide: ROLE_ASSIGNMENT_WRITER,
      inject: [APP_CONFIG, PrismaRoleAssignmentWriter, InMemoryRoleAssignmentWriter],
      useFactory: (
        config: AppConfig,
        prisma: PrismaRoleAssignmentWriter,
        memory: InMemoryRoleAssignmentWriter,
      ) => (inMemory(config) ? memory : prisma),
    },
    MembershipAccessProvider,
  ],
  exports: [AccessFacade],
})
export class AccessModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly defaultRoles: DefaultRolesSeeder,
    private readonly membershipReferences: MembershipReferences,
    private readonly membershipAccess: MembershipAccessProvider,
  ) {}

  onModuleInit(): void {
    this.seeders.register(this.defaultRoles);
    this.membershipReferences.registerAccess(this.membershipAccess);
  }
}
