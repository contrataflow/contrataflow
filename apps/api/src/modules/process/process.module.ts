import { Inject, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { ProcessAccessModule, ProcessAccessRegistry } from '#shared/auth/process-access.js';
import {
  DocumentProcessContextModule,
  DocumentProcessContextRegistry,
} from '#shared/document/document-process-context.js';
import {
  AttachmentTargetModule,
  AttachmentTargetRegistry,
} from '#shared/files/attachment-targets.js';
import { SYNC_EVENT_HANDLERS } from '#shared/outbox/outbox-writer.js';
import type { SyncEventHandlerRegistryPort } from '#shared/outbox/outbox-writer.js';

import { CreateProcessCommand } from './application/create-process.command.js';
import { DocumentProcessContextLoader } from './application/document-process-context.loader.js';
import { DuplicateCandidatesFinder } from './application/duplicate-candidates.js';
import { ListProcessesHandler } from './application/list-processes.query.js';
import {
  PROCESS_CLOCK,
  PROCESS_REPOSITORY,
  PROCESS_RUNTIME_READER,
  PROCESS_TRANSACTIONS,
} from './application/ports.js';
import { ProcessAccessProjector } from './application/process-access.projector.js';
import { ProcessRuntimeAccessReader } from './application/process-access.reader.js';
import {
  EvaluateStageRulesHandler,
  GetAvailableActionsHandler,
} from './application/process-actions.queries.js';
import { ProcessAttachmentTargets } from './application/process-attachment-targets.js';
import { ProcessRuntimeLoader } from './application/process-runtime.loader.js';
import { ProcessViewerResolver } from './application/process-viewer.js';
import { ProcessFacade } from './application/process.facade.js';
import { ProcessPresenter } from './application/process.presenter.js';
import { CheckDuplicateProcessesQuery, GetProcessQuery } from './application/process.queries.js';
import { RuleTestProcessReader } from './application/rule-test-process.source.js';
import { InMemoryProcessRepository } from './infrastructure/in-memory-process.repository.js';
import {
  PrismaProcessRepository,
  PrismaProcessTransactions,
} from './infrastructure/prisma-process.repository.js';
import {
  InMemoryProcessRuntimeReader,
  InMemoryProcessRuntimeStore,
  InMemoryProcessTransactions,
} from './infrastructure/process-runtime.readers.js';
import { ProcessActionsController } from './presentation/process-actions.controller.js';
import { ProcessController } from './presentation/process.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { WorkflowFacade } from '../workflow/application/workflow.facade.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): processos em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `process` (DEC-040, nível 3 — agregado central): outros módulos usam somente a fachada
 * exportada. US-002: lista de processos (PRC-01 — `ListProcessesHandler`). US-001: criação do processo (PRC-02, com o padrão `TransactionalCommandHandler`),
 * verificação de duplicidade (PRC-03), detalhe (PRC-04), as tabelas do agregado e do runtime da
 * tramitação e o `ProcessAccessProjector` (handler síncrono do outbox — DEC-024). US-041: PRC-08/09
 * sobre a `WorkflowFacade`. US-097: leitor do processo na porta de autorização. US-044: fonte do
 * processo de referência de "Testar regra" (WF-23) na `WorkflowFacade`. US-065: leitor do processo
 * na porta `DocumentProcessContextRegistry` do ciclo de vida do documento.
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    IdentityModule,
    OrganizationModule,
    TenancyModule,
    WorkflowModule,
    ProcessAccessModule,
    DocumentProcessContextModule,
    AttachmentTargetModule,
  ],
  controllers: [ProcessController, ProcessActionsController],
  providers: [
    ProcessAttachmentTargets,
    ProcessFacade,
    ProcessPresenter,
    ProcessViewerResolver,
    ProcessRuntimeAccessReader,
    ProcessRuntimeLoader,
    ProcessAccessProjector,
    DuplicateCandidatesFinder,
    CreateProcessCommand,
    CheckDuplicateProcessesQuery,
    GetProcessQuery,
    ListProcessesHandler,
    GetAvailableActionsHandler,
    EvaluateStageRulesHandler,
    RuleTestProcessReader,
    DocumentProcessContextLoader,
    PrismaProcessRepository,
    InMemoryProcessRepository,
    InMemoryProcessRuntimeStore,
    InMemoryProcessRuntimeReader,
    PrismaProcessTransactions,
    InMemoryProcessTransactions,
    {
      provide: PROCESS_REPOSITORY,
      inject: [APP_CONFIG, PrismaProcessRepository, InMemoryProcessRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaProcessRepository,
        memory: InMemoryProcessRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: PROCESS_RUNTIME_READER,
      inject: [APP_CONFIG, ProcessRuntimeLoader, InMemoryProcessRuntimeReader],
      useFactory: (
        config: AppConfig,
        loader: ProcessRuntimeLoader,
        memory: InMemoryProcessRuntimeReader,
      ) => (inMemory(config) ? memory : loader),
    },
    {
      provide: PROCESS_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaProcessTransactions, InMemoryProcessTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaProcessTransactions,
        memory: InMemoryProcessTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: PROCESS_CLOCK, useValue: () => new Date() },
  ],
  exports: [ProcessFacade],
})
export class ProcessModule implements OnModuleInit {
  constructor(
    private readonly registry: ProcessAccessRegistry,
    private readonly reader: ProcessRuntimeAccessReader,
    @Inject(SYNC_EVENT_HANDLERS) private readonly syncHandlers: SyncEventHandlerRegistryPort,
    private readonly accessProjector: ProcessAccessProjector,
    private readonly workflow: WorkflowFacade,
    private readonly ruleTestProcesses: RuleTestProcessReader,
    private readonly documentContexts: DocumentProcessContextRegistry,
    private readonly documentContextLoader: DocumentProcessContextLoader,
    private readonly attachmentTargets: AttachmentTargetRegistry,
    private readonly processAttachmentTargets: ProcessAttachmentTargets,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.reader);
    // US-044: processo de referência de "Testar regra" (WF-23).
    this.workflow.registerRuleTestProcessSource(this.ruleTestProcesses);
    // DEC-024 · DEC-161: concessões `ProcessAccess` no mesmo `tx` do fato.
    this.syncHandlers.register(this.accessProjector);
    // US-065: o processo visto pelo ciclo de vida do documento (POL-01/02/11 · snapshot).
    this.documentContexts.register(this.documentContextLoader);
    // US-068: o processo como alvo de anexo (`PROCESS`) lido pelo `files`.
    this.attachmentTargets.register(this.processAttachmentTargets);
  }
}
