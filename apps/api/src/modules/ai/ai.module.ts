import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import {
  AiSuggestionSourceModule,
  AiSuggestionSourceRegistry,
} from '#shared/ai/ai-suggestion-source.js';
import { DocumentProcessContextModule } from '#shared/document/document-process-context.js';

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
import { DiscardAiGenerationCommand } from './application/discard-ai-generation.command.js';
import {
  AI_CLOCK,
  AI_GENERATION_REPOSITORY,
  AI_SETTINGS,
  AI_TRANSACTIONS,
} from './application/ports.js';
import type { AiSettings } from './application/ports.js';
import { RequestAiGenerationCommand } from './application/request-ai-generation.command.js';
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
import { AccessModule } from '../access/access.module.js';
import { DocumentModule } from '../document/document.module.js';
import { IdentityModule } from '../identity/identity.module.js';
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
 * timeline e notificações). Geradores concretos (US-117..121), portão do órgão (US-116) e
 * GroundingGuard (US-122) entram pelos registros `AiGeneratorRegistry`, `AiTenantGateRegistry` e
 * `AiPostProcessorRegistry`.
 */
@Module({
  imports: [
    AccessModule,
    DocumentModule,
    IdentityModule,
    TenancyModule,
    DocumentProcessContextModule,
    AiSuggestionSourceModule,
  ],
  controllers: [AiGenerationController],
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
  ],
})
export class AiModule implements OnModuleInit {
  constructor(
    private readonly suggestions: AiSuggestionSourceRegistry,
    private readonly source: AiSuggestionSourceAdapter,
  ) {}

  /** Implementa a porta `AiSuggestionSource` lida por `document`/`risk` (DEC-079). */
  onModuleInit(): void {
    this.suggestions.register(this.source);
  }
}
