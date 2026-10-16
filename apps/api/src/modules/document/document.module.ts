import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DocumentTypeCatalogModule } from '#shared/document/document-type-catalog.js';
import { DocumentTypeUsageModule } from '#shared/document/document-type-usage.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { ApprovalPolicyValidator } from './application/approval-policy.validator.js';
import { CreateDocumentTypeCommand } from './application/create-document-type.command.js';
import { DocumentTypeCodesAdapter } from './application/document-type-codes.provider.js';
import { DocumentTypeFacade } from './application/document-type.facade.js';
import { DocumentFacade } from './application/document.facade.js';
import { ListDocumentTypesQuery } from './application/list-document-types.query.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_COUNTER,
  DOCUMENT_TRANSACTIONS,
  DOCUMENT_TYPE_REPOSITORY,
} from './application/ports.js';
import { PreviewDocumentTypeImpactQuery } from './application/preview-document-type-impact.query.js';
import { SetDefaultTemplateCommand } from './application/set-default-template.command.js';
import { SystemDocumentTypesSeeder } from './application/system-document-types.seeder.js';
import { TemplateContext } from './application/template-context.js';
import {
  CreateTemplateVersionCommand,
  PublishTemplateVersionCommand,
  RetireTemplateVersionCommand,
} from './application/template-lifecycle.commands.js';
import {
  CreateTemplateCommand,
  UpdateTemplateCommand,
  UpdateTemplateVersionContentCommand,
} from './application/template.commands.js';
import { TEMPLATE_REPOSITORY } from './application/template.ports.js';
import { TemplateQueries } from './application/template.queries.js';
import { UpdateDocumentTypeCommand } from './application/update-document-type.command.js';
import {
  InMemoryDocumentTransactions,
  InMemoryDocumentTypeRepository,
  StaticDocumentCounter,
} from './infrastructure/in-memory-document-type.repository.js';
import { InMemoryTemplateRepository } from './infrastructure/in-memory-template.repository.js';
import {
  PrismaDocumentTransactions,
  PrismaDocumentTypeRepository,
} from './infrastructure/prisma-document-type.repository.js';
import { PrismaTemplateRepository } from './infrastructure/prisma-template.repository.js';
import { DocumentTypeController } from './presentation/document-type.controller.js';
import { TemplateController } from './presentation/template.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): tipos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `document` (DEC-040, nível 2): outros módulos usam somente as fachadas exportadas. Dono de
 * `DocumentType` (US-061: DTY-01..03, cache por tenant e semeadura dos tipos de sistema) e dos
 * templates (US-107: TPL-01..04/07/08 e o `TemplateContentValidator`; US-108: TPL-05/06/10/11 e o
 * template padrão do tipo, DTY-04); documentos e versões chegam com as stories seguintes. Autorização e MFA vêm de `access`/`identity`;
 * a verificação de uso em fluxos publicados, da porta `DocumentTypeUsageProvider` (implementada
 * por `workflow`). Implementa a porta `DocumentTypeCatalog` lida por `workflow` (US-040).
 */
@Module({
  imports: [
    AccessModule,
    IdentityModule,
    OrganizationModule,
    DocumentTypeUsageModule,
    DocumentTypeCatalogModule,
    TenantSeedingModule,
  ],
  controllers: [DocumentTypeController, TemplateController],
  providers: [
    DocumentFacade,
    DocumentTypeFacade,
    ApprovalPolicyValidator,
    ListDocumentTypesQuery,
    CreateDocumentTypeCommand,
    UpdateDocumentTypeCommand,
    PreviewDocumentTypeImpactQuery,
    SystemDocumentTypesSeeder,
    DocumentTypeCodesAdapter,
    PrismaDocumentTypeRepository,
    PrismaDocumentTransactions,
    InMemoryDocumentTypeRepository,
    InMemoryDocumentTransactions,
    TemplateContext,
    TemplateQueries,
    CreateTemplateCommand,
    UpdateTemplateCommand,
    UpdateTemplateVersionContentCommand,
    CreateTemplateVersionCommand,
    PublishTemplateVersionCommand,
    RetireTemplateVersionCommand,
    SetDefaultTemplateCommand,
    PrismaTemplateRepository,
    InMemoryTemplateRepository,
    {
      provide: TEMPLATE_REPOSITORY,
      inject: [APP_CONFIG, PrismaTemplateRepository, InMemoryTemplateRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaTemplateRepository,
        memory: InMemoryTemplateRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: DOCUMENT_TYPE_REPOSITORY,
      inject: [APP_CONFIG, PrismaDocumentTypeRepository, InMemoryDocumentTypeRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDocumentTypeRepository,
        memory: InMemoryDocumentTypeRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: DOCUMENT_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaDocumentTransactions, InMemoryDocumentTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDocumentTransactions,
        memory: InMemoryDocumentTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    // `documents` (US-062/US-065) ainda não existe: nenhum documento usa o tipo.
    { provide: DOCUMENT_COUNTER, useValue: new StaticDocumentCounter() },
    { provide: DOCUMENT_CLOCK, useValue: () => new Date() },
  ],
  exports: [DocumentFacade, DocumentTypeFacade],
})
export class DocumentModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly systemTypes: SystemDocumentTypesSeeder,
  ) {}

  /** Seeder `document.systemTypes` no checklist de provisionamento (US-099). */
  onModuleInit(): void {
    this.seeders.register(this.systemTypes);
  }
}
