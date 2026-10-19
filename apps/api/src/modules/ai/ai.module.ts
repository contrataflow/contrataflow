import { AI_TARGET_MODULES } from '@contrataflow/types';
import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  AiSuggestionSourceModule,
  AiSuggestionSourceRegistry,
} from '#shared/ai/ai-suggestion-source.js';
import { DocumentProcessContextModule } from '#shared/document/document-process-context.js';
import { ProcessItemCatalogModule } from '#shared/process/process-item-catalog.js';

import { AiCircuitBreaker } from './application/ai-circuit-breaker.js';
import {
  AiPostProcessorRegistry,
  AiTenantGateRegistry,
} from './application/ai-extension-points.js';
import { AiGenerationJob } from './application/ai-generation.job.js';
import { AiGenerationProcessor } from './application/ai-generation.processor.js';
import { AiGenerationQueries } from './application/ai-generation.queries.js';
import { AiGeneratorRegistry } from './application/ai-generator.js';
import { AiMaintenanceService } from './application/ai-maintenance.service.js';
import { AI_PROVIDER } from './application/ai-provider.port.js';
import { AiSuggestionSourceAdapter } from './application/ai-suggestion.source.js';
import { AiTenantGateService } from './application/ai-tenant-gate.service.js';
import { AiUsageQueries } from './application/ai-usage.queries.js';
import { DfdDraftGenerator } from './application/dfd-draft.generator.js';
import { DiscardAiGenerationCommand } from './application/discard-ai-generation.command.js';
import {
  AI_CLOCK,
  AI_GENERATION_REPOSITORY,
  AI_SETTINGS,
  AI_TRANSACTIONS,
} from './application/ports.js';
import type { AiSettings } from './application/ports.js';
import { RequestAiGenerationCommand } from './application/request-ai-generation.command.js';
import { RiskMapDraftGenerator } from './application/risk-map-draft.generator.js';
import { SectionAdjustGenerator } from './application/section-adjust.generator.js';
import { GroundingGuard } from './domain/grounding-guard.js';
import {
  DEFAULT_FAKE_AI_FIXTURES_DIR,
  FakeAiProvider,
  loadFakeAiFixtures,
} from './infrastructure/fake-ai.provider.js';
import {
  InMemoryAiGenerationRepository,
  InMemoryAiTransactions,
} from './infrastructure/in-memory-ai-generation.repository.js';
import {
  PrismaAiGenerationRepository,
  PrismaAiTransactions,
} from './infrastructure/prisma-ai-generation.repository.js';
import { UnavailableAiProvider } from './infrastructure/unavailable-ai.provider.js';
import { AiGenerationController } from './presentation/ai-generation.controller.js';
import { AiUsageController } from './presentation/ai-usage.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogFacade } from '../catalog/application/catalog.facade.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DfdModule } from '../dfd/dfd.module.js';
import { DocumentFacade } from '../document/application/document.facade.js';
import { DocumentModule } from '../document/document.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessFacade } from '../process/application/process.facade.js';
import { ProcessModule } from '../process/process.module.js';
import { RiskModule } from '../risk/risk.module.js';
import { TenancyFacade } from '../tenancy/application/tenancy.facade.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): gerações em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/** Teto do contexto serializado enviado ao provedor (FA-07): ~60 mil tokens. */
const MAX_CONTEXT_CHARS = 240_000;

/**
 * Módulo `ai` (DEC-040/DEC-079, nível 5 — "leitura e efeitos colaterais"): dono de
 * `AiGeneration`. Lê outros módulos SÓ por fachadas de leitura (regra D9 — dependency-cruiser
 * `ai-read-only`) e nunca executa comando de outro contexto: a aplicação do conteúdo é comando de
 * `document`/`risk`, que leem a proposta pela porta `AiSuggestionSource` implementada aqui. US-115:
 * a camada (AI-01..04, pipeline, `AiProvider` + `FakeAiProvider`, disjuntor, custo, auditoria,
 * timeline e notificações). US-116: o portão do órgão (`AiTenantGateService`, registrado no
 * `AiTenantGateRegistry`) e AI-05/AI-06. Geradores concretos (US-117: `DfdDraftGenerator`; US-119: `RiskMapDraftGenerator`; US-121:
 * `SectionAdjustGenerator` por documento; US-118/120) e GroundingGuard
 * (US-122) entram pelos registros `AiGeneratorRegistry` e `AiPostProcessorRegistry`.
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    DfdModule,
    DocumentModule,
    IdentityModule,
    OrganizationModule,
    ProcessModule,
    RiskModule,
    TenancyModule,
    DocumentProcessContextModule,
    AiSuggestionSourceModule,
    ProcessItemCatalogModule,
  ],
  controllers: [AiGenerationController, AiUsageController],
  providers: [
    {
      provide: AI_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AiSettings => ({
        provider: config.ai.provider,
        models: config.ai.models,
        requestTimeoutMs: config.ai.requestTimeoutMs,
        maxAttempts: 3,
        backoffBaseMs: 10_000,
        maxContextChars: MAX_CONTEXT_CHARS,
      }),
    },
    {
      provide: AI_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.ai.provider === 'fake'
          ? new FakeAiProvider(loadFakeAiFixtures(DEFAULT_FAKE_AI_FIXTURES_DIR))
          : new UnavailableAiProvider(),
    },
    PrismaAiGenerationRepository,
    InMemoryAiGenerationRepository,
    {
      provide: AI_GENERATION_REPOSITORY,
      inject: [APP_CONFIG, PrismaAiGenerationRepository, InMemoryAiGenerationRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaAiGenerationRepository,
        memory: InMemoryAiGenerationRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    PrismaAiTransactions,
    {
      provide: AI_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaAiTransactions],
      useFactory: (config: AppConfig, prisma: PrismaAiTransactions) =>
        inMemory(config) ? new InMemoryAiTransactions() : prisma,
    },
    { provide: AI_CLOCK, useValue: () => new Date() },
    AiGeneratorRegistry,
    AiTenantGateRegistry,
    AiPostProcessorRegistry,
    AiCircuitBreaker,
    RequestAiGenerationCommand,
    DiscardAiGenerationCommand,
    AiGenerationQueries,
    AiGenerationProcessor,
    AiGenerationJob,
    AiMaintenanceService,
    AiSuggestionSourceAdapter,
    AiTenantGateService,
    AiUsageQueries,
    DfdDraftGenerator,
    RiskMapDraftGenerator,
  ],
})
export class AiModule implements OnModuleInit {
  constructor(
    private readonly suggestions: AiSuggestionSourceRegistry,
    private readonly source: AiSuggestionSourceAdapter,
    private readonly gates: AiTenantGateRegistry,
    private readonly gate: AiTenantGateService,
    private readonly postProcessors: AiPostProcessorRegistry,
    private readonly generators: AiGeneratorRegistry,
    private readonly dfdDraft: DfdDraftGenerator,
    private readonly riskMapDraft: RiskMapDraftGenerator,
    private readonly documents: DocumentFacade,
    private readonly processes: ProcessFacade,
    private readonly catalog: CatalogFacade,
    private readonly tenancy: TenancyFacade,
  ) {}

  /**
   * Implementa a porta `AiSuggestionSource` lida por `document`/`risk` (DEC-079) e registra o
   * portão do órgão (US-116: IA ligada, limites, reserva e avisos de consumo) e o GroundingGuard
   * na cadeia de pós-processamento (US-122 · RN-AI-54) e os geradores concretos (US-117: `DFD`/`DRAFT`;
   * US-119: `RISK_MAP`/`DRAFT`; US-121: `<documento>`/`SECTION` nos quatro documentos).
   */
  onModuleInit(): void {
    this.suggestions.register(this.source);
    this.gates.register(this.gate);
    const deps = {
      documents: this.documents,
      processes: this.processes,
      catalog: this.catalog,
      tenancy: this.tenancy,
    };
    const sectionAdjusts = AI_TARGET_MODULES.map(
      (targetModule) => new SectionAdjustGenerator(targetModule, deps),
    );
    for (const generator of [this.dfdDraft, this.riskMapDraft, ...sectionAdjusts]) {
      if (this.generators.find(generator.targetModule, generator.kind) === undefined) {
        this.generators.register(generator);
      }
    }
    const guard = new GroundingGuard();
    if (!this.postProcessors.all().some((processor) => processor.name === guard.name)) {
      this.postProcessors.register(guard);
    }
  }
}
