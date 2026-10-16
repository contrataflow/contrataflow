import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { ProcessAccessModule, ProcessAccessRegistry } from '#shared/auth/process-access.js';

import { PROCESS_RUNTIME_READER, PROCESS_TRANSACTIONS } from './application/ports.js';
import { ProcessRuntimeAccessReader } from './application/process-access.reader.js';
import {
  EvaluateStageRulesHandler,
  GetAvailableActionsHandler,
} from './application/process-actions.queries.js';
import { ProcessViewerResolver } from './application/process-viewer.js';
import { ProcessFacade } from './application/process.facade.js';
import {
  InMemoryProcessRuntimeStore,
  InMemoryProcessTransactions,
  PendingProcessRuntimeReader,
  PrismaProcessTransactions,
} from './infrastructure/process-runtime.readers.js';
import { ProcessActionsController } from './presentation/process-actions.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): runtime em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `process` (DEC-040, nível 3): outros módulos usam somente a fachada exportada. US-041:
 * PRC-08/PRC-09 sobre a `WorkflowFacade` (motor de workflow), com a visibilidade da DEC-024. O
 * runtime do processo vem da porta `PROCESS_RUNTIME_READER` — em produção, `PendingProcessRuntimeReader`
 * até a US-001 criar as tabelas do agregado. US-097: registra o leitor do processo na porta de
 * autorização (`ProcessAccessRegistry` — `@RequirePermission(…, { scope: { processParam } })`).
 */
@Module({
  imports: [AccessModule, IdentityModule, OrganizationModule, WorkflowModule, ProcessAccessModule],
  controllers: [ProcessActionsController],
  providers: [
    ProcessFacade,
    ProcessViewerResolver,
    ProcessRuntimeAccessReader,
    GetAvailableActionsHandler,
    EvaluateStageRulesHandler,
    PendingProcessRuntimeReader,
    InMemoryProcessRuntimeStore,
    PrismaProcessTransactions,
    InMemoryProcessTransactions,
    {
      provide: PROCESS_RUNTIME_READER,
      inject: [APP_CONFIG, PendingProcessRuntimeReader, InMemoryProcessRuntimeStore],
      useFactory: (
        config: AppConfig,
        pending: PendingProcessRuntimeReader,
        memory: InMemoryProcessRuntimeStore,
      ) => (inMemory(config) ? memory : pending),
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
  ],
  exports: [ProcessFacade],
})
export class ProcessModule implements OnModuleInit {
  constructor(
    private readonly registry: ProcessAccessRegistry,
    private readonly reader: ProcessRuntimeAccessReader,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.reader);
  }
}
