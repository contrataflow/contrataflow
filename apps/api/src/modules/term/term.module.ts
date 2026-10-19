import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { PriceResearchSummaryModule } from '#shared/price-research/price-research-summary.js';

import { TERM_CLOCK, TERM_REPOSITORY, TERM_TRANSACTIONS } from './application/ports.js';
import { CreateTermCommand } from './application/term.commands.js';
import { TermFacade } from './application/term.facade.js';
import { GetTermQuery, ListProcessTermsQuery } from './application/term.queries.js';
import { UpdateTermHeaderCommand } from './application/update-term-header.command.js';
import {
  InMemoryTermRepository,
  InMemoryTermTransactions,
  PrismaTermRepository,
  PrismaTermTransactions,
} from './infrastructure/term.repositories.js';
import { TermController } from './presentation/term.controller.js';
import { DocumentModule } from '../document/document.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): TRs em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `term` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono de
 * `TermOfReference` (US-036: TRM-01..04 — criação a partir do template, leitura com o rascunho por
 * seção e o painel "Dados do TR"). O documento, a numeração e as seções (DOC-05) vêm do `document`
 * pelo padrão de documento tipado (`createStructuredIn`); a pesquisa de preços concluída, da porta
 * `PriceResearchSummaryRegistry` (o `price-research` é do mesmo nível).
 */
@Module({
  imports: [DocumentModule, PriceResearchSummaryModule],
  controllers: [TermController],
  providers: [
    TermFacade,
    CreateTermCommand,
    UpdateTermHeaderCommand,
    ListProcessTermsQuery,
    GetTermQuery,
    PrismaTermRepository,
    PrismaTermTransactions,
    InMemoryTermTransactions,
    { provide: InMemoryTermRepository, useFactory: () => new InMemoryTermRepository() },
    {
      provide: TERM_REPOSITORY,
      inject: [APP_CONFIG, PrismaTermRepository, InMemoryTermRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTermRepository,
        memory: InMemoryTermRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: TERM_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaTermTransactions, InMemoryTermTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTermTransactions,
        memory: InMemoryTermTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: TERM_CLOCK, useValue: () => new Date() },
  ],
  exports: [TermFacade],
})
export class TermModule {}
