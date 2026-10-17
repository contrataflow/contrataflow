import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { RISK_CLOCK, RISK_REPOSITORY, RISK_TRANSACTIONS } from './application/ports.js';
import {
  CreateRiskCommand,
  DeleteRiskCommand,
  UpdateRiskCommand,
} from './application/risk.commands.js';
import { RiskFacade } from './application/risk.facade.js';
import { GetRiskQuery, ListRisksQuery } from './application/risk.queries.js';
import {
  RiskChangeRecorder,
  RiskGate,
  RiskPresenter,
  RiskReferences,
  RiskScaleReader,
} from './application/risk.support.js';
import {
  InMemoryRiskRepository,
  InMemoryRiskTransactions,
} from './infrastructure/in-memory-risk.repository.js';
import {
  PrismaRiskRepository,
  PrismaRiskTransactions,
} from './infrastructure/prisma-risk.repository.js';
import { RiskController } from './presentation/risk.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DocumentModule } from '../document/document.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): riscos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `risk` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono de `Risk`
 * e `RiskTreatment` (DEC-021). US-033: registrar e avaliar riscos (RSK-01..05) — a POL-02 estendida
 * (RN-RISK-09) vem da fachada do `document`, a escala do `tenancy`, a categoria do `catalog` e os
 * responsáveis de `identity`/`organization`.
 */
@Module({
  imports: [CatalogModule, DocumentModule, IdentityModule, OrganizationModule, TenancyModule],
  controllers: [RiskController],
  providers: [
    RiskFacade,
    ListRisksQuery,
    GetRiskQuery,
    CreateRiskCommand,
    UpdateRiskCommand,
    DeleteRiskCommand,
    RiskGate,
    RiskScaleReader,
    RiskReferences,
    RiskPresenter,
    RiskChangeRecorder,
    PrismaRiskRepository,
    PrismaRiskTransactions,
    InMemoryRiskTransactions,
    { provide: InMemoryRiskRepository, useFactory: () => new InMemoryRiskRepository() },
    {
      provide: RISK_REPOSITORY,
      inject: [APP_CONFIG, PrismaRiskRepository, InMemoryRiskRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaRiskRepository,
        memory: InMemoryRiskRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: RISK_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaRiskTransactions, InMemoryRiskTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaRiskTransactions,
        memory: InMemoryRiskTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: RISK_CLOCK, useValue: () => new Date() },
  ],
  exports: [RiskFacade],
})
export class RiskModule {}
