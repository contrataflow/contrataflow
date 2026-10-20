import { createHash, createHmac } from 'node:crypto';

import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { EtpHeaderModule } from '#shared/etp/etp-header.js';
import { PriceResearchSummaryModule } from '#shared/price-research/price-research-summary.js';

import {
  ApplyTermEtpImportCommand,
  PreviewTermEtpImportQuery,
  TermEtpImportReader,
} from './application/etp-import.commands.js';
import {
  TERM_CLOCK,
  TERM_IMPORT_TOKEN_KEY,
  TERM_REPOSITORY,
  TERM_TRANSACTIONS,
} from './application/ports.js';
import { TermDocumentValidator } from './application/term-document.validator.js';
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
import { CatalogModule } from '../catalog/catalog.module.js';
import { DocumentFacade } from '../document/application/document.facade.js';
import { DocumentModule } from '../document/document.module.js';
import { ProcessModule } from '../process/process.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): TRs em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Chave HMAC do `importToken` (US-037 · RN-TR-18): derivada da chave do *blind index* (segredo do
 * ambiente, ≥ 32 bytes — DEC-086) com rótulo próprio, sem variável de ambiente nova; fora de
 * produção, sem a chave, uma derivação fixa de desenvolvimento (como a `platform`).
 */
function importTokenKey(config: AppConfig): Buffer {
  const base =
    config.fieldProtection.blindIndexKey === null
      ? createHash('sha256').update('contrataflow:dev-only:blind-index').digest()
      : Buffer.from(config.fieldProtection.blindIndexKey, 'base64');
  return createHmac('sha256', base).update('contrataflow:term-import-token:v1').digest();
}

/**
 * Módulo `term` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono de
 * `TermOfReference` (US-036: TRM-01..04 — criação a partir do template, leitura com o rascunho por
 * seção e o painel "Dados do TR"). O documento, a numeração e as seções (DOC-05) vêm do `document`
 * pelo padrão de documento tipado (`createStructuredIn`); a pesquisa de preços concluída, da porta
 * `PriceResearchSummaryRegistry` (o `price-research` é do mesmo nível). US-037: TRM-05/06 —
 * importação do ETP (seções e itens pelo `document`, cabeçalho do ETP pela porta
 * `EtpHeaderRegistry`, data local pelo calendário do `catalog`). US-039: o `TermDocumentValidator`
 * (completude `TR_*`, `typedSummary` e snapshot da versão) entra no registro do `document` —
 * DOC-08/DOC-09/DOC-10 genéricos; o sigilo do orçamento vem do `process`.
 */
@Module({
  imports: [
    DocumentModule,
    CatalogModule,
    ProcessModule,
    PriceResearchSummaryModule,
    EtpHeaderModule,
  ],
  controllers: [TermController],
  providers: [
    TermFacade,
    CreateTermCommand,
    UpdateTermHeaderCommand,
    TermEtpImportReader,
    PreviewTermEtpImportQuery,
    ApplyTermEtpImportCommand,
    TermDocumentValidator,
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
    { provide: TERM_IMPORT_TOKEN_KEY, inject: [APP_CONFIG], useFactory: importTokenKey },
  ],
  exports: [TermFacade],
})
export class TermModule implements OnModuleInit {
  constructor(
    private readonly documents: DocumentFacade,
    private readonly validator: TermDocumentValidator,
  ) {}

  /** US-039: o validador de completude, o resumo e o snapshot do TR. */
  onModuleInit(): void {
    this.documents.registerValidator(this.validator);
  }
}
