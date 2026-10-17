import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { ProcessAccessModule } from '#shared/auth/process-access.js';
import { AttachmentFileRegistry } from '#shared/files/attachment-files.js';
import { AttachmentTargetModule } from '#shared/files/attachment-targets.js';

import { AntivirusCircuit } from './application/antivirus-circuit.js';
import { AttachmentAccess } from './application/attachment-access.js';
import { FilesAttachmentFileReader } from './application/attachment-file.reader.js';
import { ConfirmAttachmentUploadCommand } from './application/confirm-attachment-upload.command.js';
import { CreateAttachmentIntentCommand } from './application/create-attachment-intent.command.js';
import { DeleteAttachmentCommand } from './application/delete-attachment.command.js';
import {
  ANTIVIRUS,
  ATTACHMENT_REPOSITORY,
  FILES_CLOCK,
  FILES_SETTINGS,
  FILES_TRANSACTIONS,
} from './application/files-ports.js';
import type { FilesSettings } from './application/files-ports.js';
import { FilesFacade } from './application/files.facade.js';
import { GetAttachmentDownloadQuery } from './application/get-attachment-download.query.js';
import { GetAttachmentQuery } from './application/get-attachment.query.js';
import { ScanFileJob } from './application/scan-file.job.js';
import { ScanFileProcessor } from './application/scan-file.processor.js';
import { ClamavClient, UnconfiguredAntivirus } from './infrastructure/clamav.client.js';
import {
  InMemoryAttachmentRepository,
  InMemoryFilesTransactions,
} from './infrastructure/in-memory-attachment.repository.js';
import {
  PrismaAttachmentRepository,
  PrismaFilesTransactions,
} from './infrastructure/prisma-attachment.repository.js';
import { AttachmentController } from './presentation/attachment.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): anexos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `files` (DEC-040, nível 2): outros módulos usam somente a fachada exportada. Dono de
 * `Attachment` (US-068: ATT-02/03/04/06 e o `file-scan`; US-064: ATT-05 e o leitor do arquivo do
 * anexo — porta `AttachmentFileRegistry`, lida pelo `document`). O alvo de cada anexo é lido pela porta
 * `AttachmentTargetRegistry` do shared kernel — `document` e `process` registram os seus; o storage
 * (guarda de tenant + S3) vem do `platform`, e o antivírus é o `clamd` (`CLAMAV_HOST`). O
 * `ScanFileJob` (fila `file-scan`) é consumido pelo worker, como o `AiGenerationJob` (queues.md §4.5).
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    TenancyModule,
    ProcessAccessModule,
    AttachmentTargetModule,
  ],
  controllers: [AttachmentController],
  providers: [
    FilesFacade,
    AttachmentAccess,
    CreateAttachmentIntentCommand,
    ConfirmAttachmentUploadCommand,
    GetAttachmentQuery,
    GetAttachmentDownloadQuery,
    DeleteAttachmentCommand,
    FilesAttachmentFileReader,
    AntivirusCircuit,
    ScanFileProcessor,
    ScanFileJob,
    PrismaAttachmentRepository,
    { provide: InMemoryAttachmentRepository, useFactory: () => new InMemoryAttachmentRepository() },
    {
      provide: ATTACHMENT_REPOSITORY,
      inject: [APP_CONFIG, PrismaAttachmentRepository, InMemoryAttachmentRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaAttachmentRepository,
        memory: InMemoryAttachmentRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    PrismaFilesTransactions,
    InMemoryFilesTransactions,
    {
      provide: FILES_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaFilesTransactions, InMemoryFilesTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaFilesTransactions,
        memory: InMemoryFilesTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: FILES_CLOCK, useValue: () => new Date() },
    {
      provide: FILES_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): FilesSettings => ({
        tenantQuotaBytes: config.storage.tenantQuotaBytes,
        // queues.md §4.5: 5 tentativas, base 5 s; trava = timeout do job (90 s).
        scanAttempts: 5,
        scanBackoffMs: 5_000,
        scanLeaseMs: 90_000,
      }),
    },
    {
      provide: ANTIVIRUS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.antivirus === null
          ? new UnconfiguredAntivirus()
          : new ClamavClient(config.antivirus),
    },
  ],
  exports: [FilesFacade],
})
export class FilesModule implements OnModuleInit {
  constructor(
    private readonly attachmentFiles: AttachmentFileRegistry,
    private readonly reader: FilesAttachmentFileReader,
  ) {}

  /** US-064: o arquivo do anexo lido pelo `document` (versão do documento externo). */
  onModuleInit(): void {
    this.attachmentFiles.register(this.reader);
  }
}
