import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import {
  DEPARTMENT_CLOCK,
  DEPARTMENT_REPOSITORY,
  DEPARTMENT_TRANSACTIONS,
} from './application/department-ports.js';
import { DepartmentReferences } from './application/department-references.js';
import {
  ActivateDepartmentCommand,
  CreateDepartmentCommand,
  DeactivateDepartmentCommand,
  DeleteDepartmentCommand,
  MoveDepartmentCommand,
  UpdateDepartmentCommand,
} from './application/department.commands.js';
import {
  GetDepartmentQuery,
  ListDepartmentsQuery,
  LookupDepartmentsQuery,
} from './application/department.queries.js';
import { OrganizationFacade } from './application/organization.facade.js';
import {
  InMemoryDepartmentRepository,
  InMemoryDepartmentTransactions,
} from './infrastructure/in-memory-department.repository.js';
import {
  PrismaDepartmentRepository,
  PrismaDepartmentTransactions,
} from './infrastructure/prisma-department.repository.js';
import { DepartmentController } from './presentation/department.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): unidades em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `organization` (DEC-040): outros módulos usam somente a fachada exportada
 * (`OrganizationFacade`). Dono das secretarias e setores (US-102: DEP-01..09 e a árvore com caminho
 * materializado); o órgão vem de `tenancy` e a autorização, o MFA e a elegibilidade de
 * titular/substituto de `access`/`identity` — exceções registradas em `tools/module-levels.json`.
 */
@Module({
  imports: [AccessModule, IdentityModule, TenancyModule],
  controllers: [DepartmentController],
  providers: [
    OrganizationFacade,
    DepartmentReferences,
    ListDepartmentsQuery,
    LookupDepartmentsQuery,
    GetDepartmentQuery,
    CreateDepartmentCommand,
    UpdateDepartmentCommand,
    MoveDepartmentCommand,
    ActivateDepartmentCommand,
    DeactivateDepartmentCommand,
    DeleteDepartmentCommand,
    PrismaDepartmentRepository,
    PrismaDepartmentTransactions,
    InMemoryDepartmentTransactions,
    { provide: InMemoryDepartmentRepository, useFactory: () => new InMemoryDepartmentRepository() },
    {
      provide: DEPARTMENT_REPOSITORY,
      inject: [APP_CONFIG, PrismaDepartmentRepository, InMemoryDepartmentRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDepartmentRepository,
        memory: InMemoryDepartmentRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: DEPARTMENT_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaDepartmentTransactions, InMemoryDepartmentTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDepartmentTransactions,
        memory: InMemoryDepartmentTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: DEPARTMENT_CLOCK, useValue: () => new Date() },
  ],
  exports: [OrganizationFacade],
})
export class OrganizationModule {}
