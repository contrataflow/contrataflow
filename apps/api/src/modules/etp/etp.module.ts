import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { EtpHeaderModule, EtpHeaderRegistry } from '#shared/etp/etp-header.js';
import { PriceResearchSummaryModule } from '#shared/price-research/price-research-summary.js';

import {
  CreateEtpAlternativeCommand,
  DecideEtpAlternativeCommand,
  DeleteEtpAlternativeCommand,
  UpdateEtpAlternativeCommand,
} from './application/etp-alternative.commands.js';
import { ListEtpAlternativesQuery } from './application/etp-alternative.queries.js';
import {
  EtpAlternativeGate,
  EtpAlternativeRecorder,
} from './application/etp-alternative.support.js';
import { EtpDocumentValidator } from './application/etp-document.validator.js';
import { EtpHeaderSource } from './application/etp-header.source.js';
import { UpdateEtpCommand } from './application/etp-update.command.js';
import { CreateEtpCommand } from './application/etp.commands.js';
import { EtpFacade } from './application/etp.facade.js';
import { GetEtpQuery, ListProcessEtpsQuery } from './application/etp.queries.js';
import {
  ETP_ALTERNATIVE_REPOSITORY,
  ETP_CLOCK,
  ETP_REPOSITORY,
  ETP_TRANSACTIONS,
} from './application/ports.js';
import {
  InMemoryEtpAlternativeRepository,
  PrismaEtpAlternativeRepository,
} from './infrastructure/etp-alternative.repositories.js';
import {
  InMemoryEtpRepository,
  InMemoryEtpTransactions,
  PrismaEtpRepository,
  PrismaEtpTransactions,
} from './infrastructure/etp.repositories.js';
import { EtpAlternativeController } from './presentation/etp-alternative.controller.js';
import { EtpController } from './presentation/etp.controller.js';
import { DocumentFacade } from '../document/application/document.facade.js';
import { DocumentModule } from '../document/document.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): ETPs em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `etp` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono de `Etp`
 * (US-019: ETP-01/02 — criação a partir do template com importação do DFD; US-020: ETP-03 — leitura
 * do ETP com o rascunho por seção para o editor; US-022: ETP-04 — origem e valor estimado, com o
 * vínculo à pesquisa de preços pela porta `PriceResearchSummaryRegistry` do shared kernel) e de `EtpAlternative` (US-021: ETP-05..09 —
 * alternativas de solução, pela POL-02 estendida às coleções tipadas; a fachada é a fonte
 * `ETP_ALTERNATIVE` da timeline). O documento, a
 * numeração, as seções e os itens vêm do `document` pelo padrão de documento tipado
 * (`createStructuredIn`); o DFD de origem é lido do snapshot da versão (`importableDfdIn`), sem
 * depender do módulo `dfd`. US-037: registra o leitor do cabeçalho na porta `EtpHeaderRegistry`
 * (importação do ETP no TR — o `term` é do mesmo nível). US-023: o ETP-04 também define a conclusão
 * e o parcelamento, e o `EtpDocumentValidator` (completude RN-ETP-34..36 e snapshot da versão) entra
 * no registro do `document` — DOC-08/DOC-10 genéricos.
 */
@Module({
  imports: [DocumentModule, PriceResearchSummaryModule, EtpHeaderModule],
  controllers: [EtpController, EtpAlternativeController],
  providers: [
    EtpFacade,
    EtpHeaderSource,
    CreateEtpCommand,
    UpdateEtpCommand,
    EtpDocumentValidator,
    ListProcessEtpsQuery,
    GetEtpQuery,
    ListEtpAlternativesQuery,
    CreateEtpAlternativeCommand,
    UpdateEtpAlternativeCommand,
    DeleteEtpAlternativeCommand,
    DecideEtpAlternativeCommand,
    EtpAlternativeGate,
    EtpAlternativeRecorder,
    PrismaEtpAlternativeRepository,
    {
      provide: InMemoryEtpAlternativeRepository,
      useFactory: () => new InMemoryEtpAlternativeRepository(),
    },
    {
      provide: ETP_ALTERNATIVE_REPOSITORY,
      inject: [APP_CONFIG, PrismaEtpAlternativeRepository, InMemoryEtpAlternativeRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaEtpAlternativeRepository,
        memory: InMemoryEtpAlternativeRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    PrismaEtpRepository,
    PrismaEtpTransactions,
    InMemoryEtpTransactions,
    { provide: InMemoryEtpRepository, useFactory: () => new InMemoryEtpRepository() },
    {
      provide: ETP_REPOSITORY,
      inject: [APP_CONFIG, PrismaEtpRepository, InMemoryEtpRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaEtpRepository,
        memory: InMemoryEtpRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: ETP_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaEtpTransactions, InMemoryEtpTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaEtpTransactions,
        memory: InMemoryEtpTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: ETP_CLOCK, useValue: () => new Date() },
  ],
  exports: [EtpFacade],
})
export class EtpModule implements OnModuleInit {
  constructor(
    private readonly headers: EtpHeaderRegistry,
    private readonly headerSource: EtpHeaderSource,
    private readonly documents: DocumentFacade,
    private readonly validator: EtpDocumentValidator,
  ) {}

  /**
   * US-037: o cabeçalho do ETP para a importação no TR (porta do shared kernel). US-023: o validador
   * de completude e o snapshot do ETP.
   */
  onModuleInit(): void {
    this.headers.register(this.headerSource);
    this.documents.registerValidator(this.validator);
  }
}
