import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DocumentTypeUsageModule } from '#shared/document/document-type-usage.js';

import { ApprovalPolicyValidator } from './application/approval-policy.validator.js';
import { CreateDocumentTypeCommand } from './application/create-document-type.command.js';
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
import { UpdateDocumentTypeCommand } from './application/update-document-type.command.js';
import {
  InMemoryDocumentTransactions,
  InMemoryDocumentTypeRepository,
  StaticDocumentCounter,
} from './infrastructure/in-memory-document-type.repository.js';
import {
  PrismaDocumentTransactions,
  PrismaDocumentTypeRepository,
} from './infrastructure/prisma-document-type.repository.js';
import { DocumentTypeController } from './presentation/document-type.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): tipos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `document` (DEC-040, nível 2): outros módulos usam somente as fachadas exportadas. Dono de
 * `DocumentType` (US-061: DTY-01..03, cache por tenant e semeadura dos tipos de sistema); templates,
 * documentos e versões chegam com as stories seguintes. Autorização e MFA vêm de `access`/`identity`;
 * a verificação de uso em fluxos publicados, da porta `DocumentTypeUsageProvider` (implementada
 * por `workflow`).
 */
@Module({
  imports: [AccessModule, IdentityModule, OrganizationModule, DocumentTypeUsageModule],
  controllers: [DocumentTypeController],
  providers: [
    DocumentFacade,
    DocumentTypeFacade,
    ApprovalPolicyValidator,
    ListDocumentTypesQuery,
    CreateDocumentTypeCommand,
    UpdateDocumentTypeCommand,
    PreviewDocumentTypeImpactQuery,
    PrismaDocumentTypeRepository,
    PrismaDocumentTransactions,
    InMemoryDocumentTypeRepository,
    InMemoryDocumentTransactions,
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
export class DocumentModule {}
