import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DocumentApprovalModule } from '#shared/document/document-approval.js';
import { DocumentProcessContextModule } from '#shared/document/document-process-context.js';
import { DocumentTypeCatalogModule } from '#shared/document/document-type-catalog.js';
import { DocumentTypeUsageModule } from '#shared/document/document-type-usage.js';
import {
  AttachmentTargetModule,
  AttachmentTargetRegistry,
} from '#shared/files/attachment-targets.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { ApprovalPolicyValidator } from './application/approval-policy.validator.js';
import { CreateDocumentTypeCommand } from './application/create-document-type.command.js';
import { DocumentAiTargets } from './application/document-ai-target.js';
import { DocumentApprovalTransitions } from './application/document-approval.transitions.js';
import { DocumentAttachmentTargets } from './application/document-attachment-targets.js';
import { DocumentCreationService } from './application/document-creation.service.js';
import { DocumentLifecycleService } from './application/document-lifecycle.service.js';
import { DocumentTypeCodesAdapter } from './application/document-type-codes.provider.js';
import { DocumentTypeFacade } from './application/document-type.facade.js';
import { SaveDocumentVersionCommand } from './application/document-version.commands.js';
import { DocumentVersionQueries } from './application/document-version.queries.js';
import {
  CancelDocumentCommand,
  DeleteDocumentCommand,
  FinalizeDocumentCommand,
  ReopenDocumentCommand,
  SubmitDocumentCommand,
  UpdateDocumentHeaderCommand,
} from './application/document.commands.js';
import { DocumentFacade } from './application/document.facade.js';
import { DOCUMENT_REPOSITORY, DocumentValidatorRegistry } from './application/document.ports.js';
import { DocumentQueries } from './application/document.queries.js';
import { ListDocumentTypesQuery } from './application/list-document-types.query.js';
import { PdfRendererCircuit } from './application/pdf-renderer-circuit.js';
import {
  DOCUMENT_CLOCK,
  DOCUMENT_COUNTER,
  DOCUMENT_TRANSACTIONS,
  DOCUMENT_TYPE_REPOSITORY,
} from './application/ports.js';
import { PreviewDocumentTypeImpactQuery } from './application/preview-document-type-impact.query.js';
import { GetProcessDocumentsHandler } from './application/process-documents.query.js';
import { RenderDocumentJob } from './application/render-document.job.js';
import { RenderDocumentProcessor } from './application/render-document.processor.js';
import { RenditionAccess } from './application/rendition-access.js';
import {
  RequestPreviewCommand,
  RequestRenditionCommand,
} from './application/rendition.commands.js';
import {
  DOCUMENT_RENDITION_REPOSITORY,
  PDF_RENDERER,
  RENDITION_SETTINGS,
} from './application/rendition.ports.js';
import type { RenditionSettings } from './application/rendition.ports.js';
import { GetRenditionDownloadQuery, GetRenditionQuery } from './application/rendition.queries.js';
import { ReviewAiContentCommand } from './application/review-ai-content.command.js';
import { SetDefaultTemplateCommand } from './application/set-default-template.command.js';
import { SystemDocumentTypesSeeder } from './application/system-document-types.seeder.js';
import { TemplateContext } from './application/template-context.js';
import { TemplateLibrarySeeder } from './application/template-library.seeder.js';
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
import { TEMPLATE_LIBRARY, TEMPLATE_REPOSITORY } from './application/template.ports.js';
import { TemplateQueries } from './application/template.queries.js';
import { TypedCollectionGuard } from './application/typed-collection-guard.js';
import { UpdateDocumentTypeCommand } from './application/update-document-type.command.js';
import { TEMPLATE_LIBRARY as TEMPLATE_LIBRARY_FIXTURE } from './domain/template-library.js';
import { GotenbergClient, UnconfiguredPdfRenderer } from './infrastructure/gotenberg.client.js';
import { InMemoryDocumentRenditionRepository } from './infrastructure/in-memory-document-rendition.repository.js';
import {
  InMemoryDocumentTransactions,
  InMemoryDocumentTypeRepository,
} from './infrastructure/in-memory-document-type.repository.js';
import { InMemoryDocumentRepository } from './infrastructure/in-memory-document.repository.js';
import { InMemoryTemplateRepository } from './infrastructure/in-memory-template.repository.js';
import { PrismaDocumentRenditionRepository } from './infrastructure/prisma-document-rendition.repository.js';
import {
  PrismaDocumentTransactions,
  PrismaDocumentTypeRepository,
} from './infrastructure/prisma-document-type.repository.js';
import { PrismaDocumentRepository } from './infrastructure/prisma-document.repository.js';
import { PrismaTemplateRepository } from './infrastructure/prisma-template.repository.js';
import { DocumentTypeController } from './presentation/document-type.controller.js';
import { DocumentVersionController } from './presentation/document-version.controller.js';
import { DocumentController } from './presentation/document.controller.js';
import { ProcessDocumentsController } from './presentation/process-documents.controller.js';
import {
  DocumentPreviewController,
  DocumentRenditionController,
  DocumentVersionRenditionController,
} from './presentation/rendition.controller.js';
import { TemplateController } from './presentation/template.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): tipos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `document` (DEC-040, nível 2): outros módulos usam somente as fachadas exportadas. Dono de
 * `DocumentType` (US-061: DTY-01..03, cache por tenant e semeadura dos tipos de sistema) e dos
 * templates (US-107: TPL-01..04/07/08 e o `TemplateContentValidator`; US-108: TPL-05/06/10/11 e o
 * template padrão do tipo, DTY-04) e dos documentos e versões (US-065: DOC-03/04/08..14, o
 * `DocumentLifecycleService` de DEC-018 e a porta `DocumentValidator` dos módulos tipados — o
 * processo chega pela porta `DocumentProcessContextRegistry`, implementada por `process`; a
 * aprovação avulsa, pela `DocumentApprovalRegistry`, implementada por `approval`). Autorização e MFA vêm de `access`/`identity`;
 * a verificação de uso em fluxos publicados, da porta `DocumentTypeUsageProvider` (implementada
 * por `workflow`). Implementa a porta `DocumentTypeCatalog` lida por `workflow` (US-040). Dono das
 * renditions em PDF (US-067: DOC-20..23 e o `RenderDocumentJob` da fila `document-render`).
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    IdentityModule,
    OrganizationModule,
    TenancyModule,
    DocumentTypeUsageModule,
    DocumentTypeCatalogModule,
    DocumentProcessContextModule,
    DocumentApprovalModule,
    TenantSeedingModule,
    AttachmentTargetModule,
  ],
  controllers: [
    DocumentTypeController,
    TemplateController,
    DocumentController,
    DocumentVersionController,
    ProcessDocumentsController,
    DocumentPreviewController,
    DocumentVersionRenditionController,
    DocumentRenditionController,
  ],
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
    // US-110: biblioteca padrão semeada no provisionamento.
    TemplateLibrarySeeder,
    { provide: TEMPLATE_LIBRARY, useValue: TEMPLATE_LIBRARY_FIXTURE },
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
    // US-065: documentos e versões; o ciclo de vida (DEC-018) e a extensão por módulo tipado.
    PrismaDocumentRepository,
    InMemoryDocumentRepository,
    {
      provide: DOCUMENT_REPOSITORY,
      inject: [APP_CONFIG, PrismaDocumentRepository, InMemoryDocumentRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDocumentRepository,
        memory: InMemoryDocumentRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    // RN-DOC-04 · prévia de impacto (US-061): documentos não excluídos do tipo.
    { provide: DOCUMENT_COUNTER, useExisting: DOCUMENT_REPOSITORY },
    DocumentValidatorRegistry,
    DocumentLifecycleService,
    DocumentCreationService,
    DocumentApprovalTransitions,
    DocumentAiTargets,
    TypedCollectionGuard,
    DocumentAttachmentTargets,
    DocumentQueries,
    UpdateDocumentHeaderCommand,
    ReviewAiContentCommand,
    FinalizeDocumentCommand,
    SubmitDocumentCommand,
    ReopenDocumentCommand,
    CancelDocumentCommand,
    DeleteDocumentCommand,
    DocumentVersionQueries,
    SaveDocumentVersionCommand,
    // US-062: painel de documentos do processo (DOC-01).
    GetProcessDocumentsHandler,
    { provide: DOCUMENT_CLOCK, useValue: () => new Date() },
    // US-067: PDFs (DOC-20..23) e o `document-render` (consumido pelo worker, como o `file-scan`).
    RenditionAccess,
    RequestPreviewCommand,
    RequestRenditionCommand,
    GetRenditionQuery,
    GetRenditionDownloadQuery,
    PdfRendererCircuit,
    RenderDocumentProcessor,
    RenderDocumentJob,
    PrismaDocumentRenditionRepository,
    {
      provide: InMemoryDocumentRenditionRepository,
      useFactory: () => new InMemoryDocumentRenditionRepository(),
    },
    {
      provide: DOCUMENT_RENDITION_REPOSITORY,
      inject: [APP_CONFIG, PrismaDocumentRenditionRepository, InMemoryDocumentRenditionRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaDocumentRenditionRepository,
        memory: InMemoryDocumentRenditionRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: PDF_RENDERER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.pdf === null ? new UnconfiguredPdfRenderer() : new GotenbergClient(config.pdf),
    },
    {
      provide: RENDITION_SETTINGS,
      // queues.md §4.4/§10.1: 5 tentativas, base 5 s; trava = timeout do job (60 s).
      useValue: {
        attempts: 5,
        backoffMs: 5_000,
        leaseMs: 60_000,
        timeZone: 'America/Sao_Paulo',
      } satisfies RenditionSettings,
    },
  ],
  exports: [DocumentFacade, DocumentTypeFacade],
})
export class DocumentModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly systemTypes: SystemDocumentTypesSeeder,
    private readonly templateLibrary: TemplateLibrarySeeder,
    private readonly attachmentTargets: AttachmentTargetRegistry,
    private readonly documentAttachmentTargets: DocumentAttachmentTargets,
  ) {}

  /**
   * Seeders `document.systemTypes` e `document.templateLibrary` (US-099 · US-110) e os alvos de
   * anexo `DOCUMENT`/`DOCUMENT_VERSION` lidos pelo `files` (US-068).
   */
  onModuleInit(): void {
    this.seeders.register(this.systemTypes);
    this.seeders.register(this.templateLibrary);
    this.attachmentTargets.register(this.documentAttachmentTargets);
  }
}
