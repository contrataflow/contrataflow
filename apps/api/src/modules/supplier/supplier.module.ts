import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import {
  SUPPLIER_CLOCK,
  SUPPLIER_REPOSITORY,
  SUPPLIER_TRANSACTIONS,
} from './application/supplier-ports.js';
import { SupplierUsageRegistry } from './application/supplier-usage.registry.js';
import {
  CreateSupplierCommand,
  DeleteSupplierCommand,
  UpdateSupplierCommand,
} from './application/supplier.commands.js';
import { SupplierFacade } from './application/supplier.facade.js';
import {
  GetSupplierQuery,
  ListSuppliersQuery,
  LookupSupplierQuery,
} from './application/supplier.queries.js';
import {
  InMemorySupplierRepository,
  InMemorySupplierTransactions,
} from './infrastructure/in-memory-supplier.repository.js';
import {
  PrismaSupplierRepository,
  PrismaSupplierTransactions,
} from './infrastructure/prisma-supplier.repository.js';
import { SupplierController } from './presentation/supplier.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): fornecedores em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `supplier` (DEC-040): outros módulos usam somente a fachada exportada. Dono do cadastro de
 * fornecedores do tenant (US-025: SUP-01..06); a autorização e a política de MFA vêm de
 * `access`/`identity`, a proteção do CPF (criptografia + blind index) da porta `FIELD_PROTECTION`
 * do `platform` e o uso por fonte de preço dos provedores que `price-research` registra (US-026).
 */
@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [SupplierController],
  providers: [
    SupplierFacade,
    SupplierUsageRegistry,
    ListSuppliersQuery,
    LookupSupplierQuery,
    GetSupplierQuery,
    CreateSupplierCommand,
    UpdateSupplierCommand,
    DeleteSupplierCommand,
    PrismaSupplierRepository,
    PrismaSupplierTransactions,
    InMemorySupplierTransactions,
    { provide: InMemorySupplierRepository, useFactory: () => new InMemorySupplierRepository() },
    {
      provide: SUPPLIER_REPOSITORY,
      inject: [APP_CONFIG, PrismaSupplierRepository, InMemorySupplierRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaSupplierRepository,
        memory: InMemorySupplierRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: SUPPLIER_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaSupplierTransactions, InMemorySupplierTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaSupplierTransactions,
        memory: InMemorySupplierTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: SUPPLIER_CLOCK, useValue: () => new Date() },
  ],
  exports: [SupplierFacade],
})
export class SupplierModule {}
