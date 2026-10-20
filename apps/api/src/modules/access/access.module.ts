import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { AUTHORIZATION_PORT } from '#shared/auth/authorization.js';
import {
  MembershipReferences,
  MembershipReferencesModule,
} from '#shared/auth/membership-references.js';
import { ProcessAccessModule } from '#shared/auth/process-access.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { AccessFacade } from './application/access.facade.js';
import { ApprovalCompetenceService } from './application/approval-competence.service.js';
import { AuthorizationService } from './application/authorization.service.js';
import { DefaultRolesSeeder } from './application/default-roles.seeder.js';
import { EffectivePermissionsService } from './application/effective-permissions.service.js';
import { GetMyPermissionsHandler } from './application/get-my-permissions.query.js';
import { ListPermissionsQuery } from './application/list-permissions.query.js';
import { MembershipAccessProvider } from './application/membership-access.provider.js';
import {
  ACCESS_CLOCK,
  ACCESS_TRANSACTIONS,
  ROLE_ASSIGNMENT_COUNTER,
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
} from './application/ports.js';
import { RoleActorResolver } from './application/role-actor.js';
import {
  AssignmentActorResolver,
  AssignRoleCommand,
  ListRoleAssignmentsQuery,
  ListUserRoleAssignmentsQuery,
  RevokeRoleAssignmentCommand,
  RoleAssignmentSupport,
} from './application/role-assignment.commands.js';
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
import { PrismaRoleRepository } from './infrastructure/prisma-role.repository.js';
import {
  InMemoryRoleAssignmentRepository,
  PrismaRoleAssignmentRepository,
} from './infrastructure/role-assignment.repository.js';
import { MyPermissionsController } from './presentation/my-permissions.controller.js';
import { PermissionController } from './presentation/permission.controller.js';
import { RoleAssignmentController } from './presentation/role-assignment.controller.js';
import { RoleController } from './presentation/role.controller.js';
import { IdentityModule } from '../identity/identity.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): perfis em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `access` (DEC-040): outros módulos usam somente a fachada exportada. Dono do catálogo de
 * permissões (ROL-01) e dos perfis do tenant — seeder `access.defaultRoles` dos 15 perfis padrão
 * (US-094), registrado no checklist de provisionamento (US-099), e gestão de perfis e matriz
 * (ROL-02..08 · US-095; MFA via `IdentityFacade.mfaPolicy` — exceção de nível em DEC-041),
 * atribuição de perfis com escopo e vigência (ROL-09..12 · US-096) e o mecanismo único de
 * autorização (US-097): permissões efetivas com cache, `AuthorizationService` exportado como
 * `AUTHORIZATION_PORT` para o `AuthorizationGuard` global e ME-03.
 */
@Module({
  imports: [TenantSeedingModule, IdentityModule, MembershipReferencesModule, ProcessAccessModule],
  controllers: [
    PermissionController,
    RoleController,
    RoleAssignmentController,
    MyPermissionsController,
  ],
  providers: [
    AccessFacade,
    // US-051: competência de aprovar por perfil (detentores no escopo da unidade solicitante).
    ApprovalCompetenceService,
    // US-097: permissões efetivas (cache Redis), decisão única e ME-03.
    EffectivePermissionsService,
    AuthorizationService,
    { provide: AUTHORIZATION_PORT, useExisting: AuthorizationService },
    GetMyPermissionsHandler,
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
    // US-096: atribuições com escopo e vigência (ROL-09..12).
    AssignmentActorResolver,
    RoleAssignmentSupport,
    ListRoleAssignmentsQuery,
    ListUserRoleAssignmentsQuery,
    AssignRoleCommand,
    RevokeRoleAssignmentCommand,
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
    // `role_assignments`: perfil inicial do convite (US-091, pela porta `MembershipReferences`),
    // POL-12 da US-092, contagem por perfil (US-095) e a gestão contínua (US-096).
    PrismaRoleAssignmentRepository,
    InMemoryRoleAssignmentRepository,
    {
      provide: ROLE_ASSIGNMENT_REPOSITORY,
      inject: [APP_CONFIG, PrismaRoleAssignmentRepository, InMemoryRoleAssignmentRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaRoleAssignmentRepository,
        memory: InMemoryRoleAssignmentRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: ROLE_ASSIGNMENT_COUNTER, useExisting: ROLE_ASSIGNMENT_REPOSITORY },
    MembershipAccessProvider,
  ],
  exports: [AccessFacade, AUTHORIZATION_PORT],
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
