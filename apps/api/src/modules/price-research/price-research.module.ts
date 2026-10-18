import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { ProcessItemCatalogModule } from '#shared/process/process-item-catalog.js';
import {
  ProcessItemUsageModule,
  ProcessItemUsageRegistry,
} from '#shared/process/process-item-usage.js';

import {
  PRICE_RESEARCH_CLOCK,
  PRICE_RESEARCH_REPOSITORY,
  PRICE_RESEARCH_TRANSACTIONS,
} from './application/ports.js';
import { PriceItemUsageReader } from './application/price-item-usage.reader.js';
import {
  AddPriceItemsCommand,
  CreatePriceResearchCommand,
  RemovePriceItemCommand,
  UpdatePriceResearchHeaderCommand,
} from './application/price-research.commands.js';
import { PriceResearchFacade } from './application/price-research.facade.js';
import {
  GetPriceResearchQuery,
  ListPriceItemsQuery,
  ListProcessPriceResearchQuery,
} from './application/price-research.queries.js';
import {
  PriceParametersReader,
  PriceResearchGate,
  PriceResearchPresenter,
  PriceResearchRecorder,
  ResearchItemsReader,
} from './application/price-research.support.js';
import {
  InMemoryPriceResearchRepository,
  InMemoryPriceResearchTransactions,
  PrismaPriceResearchRepository,
  PrismaPriceResearchTransactions,
} from './infrastructure/price-research.repositories.js';
import { PriceResearchController } from './presentation/price-research.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DocumentModule } from '../document/document.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): pesquisas em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `price-research` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono
 * de `PriceResearch` e `PriceItem` (US-024: PRS-01..06/08). O documento, a numeração, a POL-02
 * estendida e as quantidades de ETP/DFD vêm do `document` (padrão de documento tipado); os itens do
 * processo, da porta `ProcessItemCatalogRegistry`; as unidades e o fuso, do `catalog`; os
 * parâmetros, do `tenancy`. O uso dos itens (`ITEM_IN_USE`) é publicado ao `process` pela porta
 * `ProcessItemUsageRegistry`.
 */
@Module({
  imports: [
    CatalogModule,
    DocumentModule,
    TenancyModule,
    ProcessItemCatalogModule,
    ProcessItemUsageModule,
  ],
  controllers: [PriceResearchController],
  providers: [
    PriceResearchFacade,
    CreatePriceResearchCommand,
    UpdatePriceResearchHeaderCommand,
    AddPriceItemsCommand,
    RemovePriceItemCommand,
    GetPriceResearchQuery,
    ListProcessPriceResearchQuery,
    ListPriceItemsQuery,
    PriceResearchGate,
    ResearchItemsReader,
    PriceParametersReader,
    PriceResearchPresenter,
    PriceResearchRecorder,
    PriceItemUsageReader,
    PrismaPriceResearchRepository,
    PrismaPriceResearchTransactions,
    InMemoryPriceResearchTransactions,
    {
      provide: InMemoryPriceResearchRepository,
      useFactory: () => new InMemoryPriceResearchRepository(),
    },
    {
      provide: PRICE_RESEARCH_REPOSITORY,
      inject: [APP_CONFIG, PrismaPriceResearchRepository, InMemoryPriceResearchRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaPriceResearchRepository,
        memory: InMemoryPriceResearchRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: PRICE_RESEARCH_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaPriceResearchTransactions, InMemoryPriceResearchTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaPriceResearchTransactions,
        memory: InMemoryPriceResearchTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: PRICE_RESEARCH_CLOCK, useValue: () => new Date() },
  ],
  exports: [PriceResearchFacade],
})
export class PriceResearchModule implements OnModuleInit {
  constructor(
    private readonly itemUsage: ProcessItemUsageRegistry,
    private readonly priceItemUsage: PriceItemUsageReader,
  ) {}

  /** US-024: os itens do processo referenciados por pesquisas (ITEM_IN_USE — US-006). */
  onModuleInit(): void {
    this.itemUsage.register(this.priceItemUsage);
  }
}
