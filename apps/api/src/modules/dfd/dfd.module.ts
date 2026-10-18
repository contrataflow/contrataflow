import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { DfdDocumentCreator } from './application/dfd-document.creator.js';
import { DfdDocumentValidator } from './application/dfd-document.validator.js';
import { DfdRuleContextContributor } from './application/dfd-rule-context.js';
import { CreateDfdCommand } from './application/dfd.commands.js';
import { DfdFacade } from './application/dfd.facade.js';
import { GetDfdQuery, ListProcessDfdsQuery } from './application/dfd.queries.js';
import { DuplicateDfdCommand } from './application/duplicate-dfd.command.js';
import { PatchDfdHeaderCommand } from './application/patch-dfd-header.command.js';
import { DFD_CLOCK, DFD_REPOSITORY, DFD_TRANSACTIONS } from './application/ports.js';
import {
  InMemoryDfdRepository,
  InMemoryDfdTransactions,
  PrismaDfdRepository,
  PrismaDfdTransactions,
} from './infrastructure/dfd.repositories.js';
import { DfdController } from './presentation/dfd.controller.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DocumentFacade } from '../document/application/document.facade.js';
import { DocumentModule } from '../document/document.module.js';
import { FilesModule } from '../files/files.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessModule } from '../process/process.module.js';
import { WorkflowFacade } from '../workflow/application/workflow.facade.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): DFDs em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `dfd` (DEC-040, nível 4): outros módulos usam somente a fachada exportada. Dono de `Dfd`
 * (US-014: DFD-01..03; US-015: DFD-04 — cabeçalho pelo autosave; US-018: DFD-05 — duplicação). O documento, a numeração, os
 * itens (DOC-06/07), as seções (DOC-05), a completude (DOC-08) e a prévia (DOC-20) vêm do `document` pelo padrão de documento tipado (`createStructuredIn` + o
 * `DfdDocumentValidator` registrado); os valores iniciais, do `process`; e `documents.DFD` do
 * `RuleContext` é contribuído aqui para o `workflow` (saída de `ABERTURA` — DEC-015).
 */
@Module({
  imports: [
    CatalogModule,
    DocumentModule,
    FilesModule,
    IdentityModule,
    OrganizationModule,
    ProcessModule,
    WorkflowModule,
  ],
  controllers: [DfdController],
  providers: [
    DfdFacade,
    CreateDfdCommand,
    DuplicateDfdCommand,
    DfdDocumentCreator,
    PatchDfdHeaderCommand,
    GetDfdQuery,
    ListProcessDfdsQuery,
    DfdDocumentValidator,
    DfdRuleContextContributor,
    PrismaDfdRepository,
    PrismaDfdTransactions,
    InMemoryDfdTransactions,
    { provide: InMemoryDfdRepository, useFactory: () => new InMemoryDfdRepository() },
    {
      provide: DFD_REPOSITORY,
      inject: [APP_CONFIG, PrismaDfdRepository, InMemoryDfdRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDfdRepository,
        memory: InMemoryDfdRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: DFD_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaDfdTransactions, InMemoryDfdTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDfdTransactions,
        memory: InMemoryDfdTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: DFD_CLOCK, useValue: () => new Date() },
  ],
  exports: [DfdFacade],
})
export class DfdModule implements OnModuleInit {
  constructor(
    private readonly documents: DocumentFacade,
    private readonly validator: DfdDocumentValidator,
    private readonly workflow: WorkflowFacade,
    private readonly ruleContext: DfdRuleContextContributor,
  ) {}

  /** RN-DFD-19: o validador de completude do DFD e o contribuidor de `documents.DFD`. */
  onModuleInit(): void {
    this.documents.registerValidator(this.validator);
    this.workflow.registerRuleContextContributor(this.ruleContext);
  }
}
