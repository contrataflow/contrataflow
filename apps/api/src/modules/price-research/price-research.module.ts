import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  AttachmentTargetModule,
  AttachmentTargetRegistry,
} from '#shared/files/attachment-targets.js';
import {
  PriceResearchSummaryModule,
  PriceResearchSummaryRegistry,
} from '#shared/price-research/price-research-summary.js';
import { ProcessItemCatalogModule } from '#shared/process/process-item-catalog.js';
import {
  ProcessItemUsageModule,
  ProcessItemUsageRegistry,
} from '#shared/process/process-item-usage.js';

import {
  PRICE_RESEARCH_CLOCK,
  PRICE_RESEARCH_REPOSITORY,
  PRICE_RESEARCH_TRANSACTIONS,
  PRICE_SOURCE_REPOSITORY,
} from './application/ports.js';
import { PriceCalculationService } from './application/price-calculation.service.js';
import { PriceItemUsageReader } from './application/price-item-usage.reader.js';
import { PriceResearchSummaryReaderImpl } from './application/price-research-summary.reader.js';
import {
  AddPriceItemsCommand,
  CreatePriceResearchCommand,
  RecalculatePriceResearchCommand,
  RemovePriceItemCommand,
  UpdatePriceItemCommand,
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
import { PriceSourceAttachmentTargets } from './application/price-source-attachment-targets.js';
import { PriceSourceSupplierUsage } from './application/price-source-supplier-usage.js';
import {
  CreatePriceSourceCommand,
  DeletePriceSourceCommand,
  DeleteQuotationCommand,
  ExcludeQuotationCommand,
  RestoreQuotationCommand,
  UpdatePriceSourceCommand,
  UpdateQuotationCommand,
  UpsertQuotationsCommand,
} from './application/price-source.commands.js';
import { ListPriceSourcesQuery } from './application/price-source.queries.js';
import {
  PriceSourceGate,
  PriceSourcePresenter,
  PriceSourceRecorder,
  PriceSourceRulesReader,
  QuotationRecalculator,
} from './application/price-source.support.js';
import {
  ApplyQuotationImportCommand,
  GetImportTemplateQuery,
  ImportItemsReader,
  PreviewQuotationImportCommand,
} from './application/quotation-import.commands.js';
import { QuotationImportStore } from './application/quotation-import.store.js';
import {
  InMemoryPriceResearchRepository,
  InMemoryPriceResearchTransactions,
  PrismaPriceResearchRepository,
  PrismaPriceResearchTransactions,
} from './infrastructure/price-research.repositories.js';
import {
  InMemoryPriceSourceRepository,
  PrismaPriceSourceRepository,
} from './infrastructure/price-source.repositories.js';
import { PriceResearchController } from './presentation/price-research.controller.js';
import { PriceSourceController } from './presentation/price-source.controller.js';
import { QuotationImportController } from './presentation/quotation-import.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DocumentModule } from '../document/document.module.js';
import { SupplierFacade } from '../supplier/application/supplier.facade.js';
import { SupplierModule } from '../supplier/supplier.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): pesquisas em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `price-research` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono
 * de `PriceResearch` e `PriceItem` (US-024: PRS-01..06/08; US-029: PRS-07/20 e o motor de cálculo). O documento, a numeração, a POL-02
 * estendida e as quantidades de ETP/DFD vêm do `document` (padrão de documento tipado); os itens do
 * processo, da porta `ProcessItemCatalogRegistry`; as unidades, os tipos de fonte e o fuso, do
 * `catalog`; os parâmetros, do `tenancy`; os fornecedores, do `supplier`. O uso dos itens
 * (`ITEM_IN_USE`) é publicado ao `process` pela porta `ProcessItemUsageRegistry`; o dos fornecedores
 * (US-026: PRS-09..15), pela `SupplierFacade`; o alvo de anexo `PRICE_SOURCE`, pela
 * `AttachmentTargetRegistry`. A importação por planilha (US-028: PRS-18/19/24) guarda o token da
 * prévia no Redis pelo `TenantCache`.
 */
@Module({
  imports: [
    CatalogModule,
    DocumentModule,
    TenancyModule,
    SupplierModule,
    AttachmentTargetModule,
    ProcessItemCatalogModule,
    ProcessItemUsageModule,
    PriceResearchSummaryModule,
  ],
  controllers: [PriceResearchController, PriceSourceController, QuotationImportController],
  providers: [
    PriceResearchFacade,
    CreatePriceResearchCommand,
    UpdatePriceResearchHeaderCommand,
    AddPriceItemsCommand,
    RemovePriceItemCommand,
    UpdatePriceItemCommand,
    RecalculatePriceResearchCommand,
    PriceCalculationService,
    GetPriceResearchQuery,
    ListProcessPriceResearchQuery,
    ListPriceItemsQuery,
    PriceResearchGate,
    ResearchItemsReader,
    PriceParametersReader,
    PriceResearchPresenter,
    PriceResearchRecorder,
    PriceItemUsageReader,
    PriceResearchSummaryReaderImpl,
    CreatePriceSourceCommand,
    UpdatePriceSourceCommand,
    DeletePriceSourceCommand,
    UpsertQuotationsCommand,
    UpdateQuotationCommand,
    DeleteQuotationCommand,
    ExcludeQuotationCommand,
    RestoreQuotationCommand,
    ListPriceSourcesQuery,
    PriceSourceGate,
    PriceSourceRulesReader,
    PriceSourcePresenter,
    PriceSourceRecorder,
    QuotationRecalculator,
    PriceSourceAttachmentTargets,
    PriceSourceSupplierUsage,
    GetImportTemplateQuery,
    PreviewQuotationImportCommand,
    ApplyQuotationImportCommand,
    ImportItemsReader,
    QuotationImportStore,
    PrismaPriceSourceRepository,
    PrismaPriceResearchRepository,
    PrismaPriceResearchTransactions,
    InMemoryPriceResearchTransactions,
    {
      provide: InMemoryPriceResearchRepository,
      useFactory: () => new InMemoryPriceResearchRepository(),
    },
    {
      // `ON DELETE CASCADE` price_items → quotations no adaptador em memória.
      provide: InMemoryPriceSourceRepository,
      inject: [InMemoryPriceResearchRepository],
      useFactory: (researches: InMemoryPriceResearchRepository) => {
        const sources = new InMemoryPriceSourceRepository();
        researches.onItemDeleted((itemId) => {
          sources.removeQuotationsOfItem(itemId);
        });
        return sources;
      },
    },
    {
      provide: PRICE_SOURCE_REPOSITORY,
      inject: [APP_CONFIG, PrismaPriceSourceRepository, InMemoryPriceSourceRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaPriceSourceRepository,
        memory: InMemoryPriceSourceRepository,
      ) => (inMemory(config) ? memory : prisma),
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
    private readonly suppliers: SupplierFacade,
    private readonly supplierUsage: PriceSourceSupplierUsage,
    private readonly attachmentTargets: AttachmentTargetRegistry,
    private readonly sourceAttachments: PriceSourceAttachmentTargets,
    private readonly summaries: PriceResearchSummaryRegistry,
    private readonly summaryReader: PriceResearchSummaryReaderImpl,
  ) {}

  /**
   * US-024: os itens do processo referenciados por pesquisas (ITEM_IN_USE — US-006). US-026: os
   * fornecedores referenciados por fontes (SUPPLIER_IN_USE — RN-PRICE-19) e o alvo de anexo
   * `PRICE_SOURCE` (RN-PRICE-28). US-036: as pesquisas concluídas para o valor estimado do TR
   * (RN-TR-07 — `PriceResearchSummaryRegistry`).
   */
  onModuleInit(): void {
    this.itemUsage.register(this.priceItemUsage);
    this.summaries.register(this.summaryReader);
    this.suppliers.registerUsageProvider(this.supplierUsage);
    this.attachmentTargets.register(this.sourceAttachments);
  }
}
