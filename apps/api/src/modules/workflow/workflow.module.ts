import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { DocumentTypeCatalogModule } from '#shared/document/document-type-catalog.js';
import { DocumentTypeUsageModule } from '#shared/document/document-type-usage.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { DefaultWorkflowsSeeder } from './application/default-workflows.seeder.js';
import { WORKFLOW_CLOCK, WORKFLOW_REPOSITORY, WORKFLOW_TRANSACTIONS } from './application/ports.js';
import { RuleContextBuilder, RuleContextContributorRegistry } from './application/rule-context.js';
import {
  ResolveWorkflowQuery,
  WorkflowApplicabilityService,
} from './application/workflow-applicability.service.js';
import { SetDefaultWorkflowCommand } from './application/workflow-default.command.js';
import { WorkflowDefinitionService } from './application/workflow-definition.service.js';
import { WorkflowDocumentTypeUsageProvider } from './application/workflow-document-type-usage.provider.js';
import { WorkflowDraftEditor } from './application/workflow-draft-editor.js';
import { WorkflowEngineService } from './application/workflow-engine.service.js';
import {
  PublishWorkflowVersionCommand,
  RetireWorkflowVersionCommand,
  ValidateWorkflowVersionQuery,
} from './application/workflow-publication.commands.js';
import { WorkflowReferenceService } from './application/workflow-references.js';
import {
  GetRuleContextSchemaQuery,
  RuleTestProcessSourceRegistry,
  TestWorkflowRuleQuery,
} from './application/workflow-rule-test.js';
import {
  CreateWorkflowRuleCommand,
  DeleteWorkflowRuleCommand,
  UpdateWorkflowRuleCommand,
} from './application/workflow-rule.commands.js';
import {
  CreateWorkflowStageCommand,
  DeleteWorkflowStageCommand,
  UpdateWorkflowStageCommand,
} from './application/workflow-stage.commands.js';
import {
  CreateWorkflowTransitionCommand,
  DeleteWorkflowTransitionCommand,
  UpdateWorkflowTransitionCommand,
} from './application/workflow-transition.commands.js';
import { WorkflowVersionPublisher } from './application/workflow-version.publisher.js';
import {
  CreateWorkflowCommand,
  CreateWorkflowVersionCommand,
  UpdateWorkflowCommand,
} from './application/workflow.commands.js';
import { WorkflowFacade } from './application/workflow.facade.js';
import {
  GetWorkflowQuery,
  GetWorkflowVersionQuery,
  ListWorkflowsQuery,
  ListWorkflowVersionsQuery,
} from './application/workflow.queries.js';
import {
  InMemoryWorkflowRepository,
  InMemoryWorkflowTransactions,
} from './infrastructure/in-memory-workflow.repository.js';
import {
  PrismaWorkflowRepository,
  PrismaWorkflowTransactions,
} from './infrastructure/prisma-workflow.repository.js';
import { WorkflowController } from './presentation/workflow.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): definições em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `workflow` (DEC-040, nível 2): outros módulos usam somente a fachada exportada. US-040:
 * modelo de definição versionado (WF-02..04, WF-07..18), validador do grafo, snapshot canônico com
 * `definitionHash` e o publicador interno. Lê os tipos de documento pela porta
 * `DocumentTypeCatalog` e implementa a porta de uso de tipos (`DocumentTypeUsageProvider` —
 * US-061); unidades, usuários e perfis vêm das fachadas de nível 1. US-041: o motor de execução
 * (`WorkflowEngineService` + `RuleContextBuilder` com os contribuidores registrados), exposto pela
 * fachada; dias úteis na etapa vêm do calendário do `catalog`. US-042: os workflows semeados
 * (`workflow.seedWorkflows`), a troca do padrão (WF-05) e a resolução da aplicabilidade (WF-06).
 * US-044: schema do RuleContext (WF-19) e "Testar regra" (WF-23, processo pela porta
 * `RuleTestProcessSource` que o `process` registra).
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    IdentityModule,
    OrganizationModule,
    DocumentTypeUsageModule,
    DocumentTypeCatalogModule,
    TenantSeedingModule,
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowFacade,
    WorkflowDocumentTypeUsageProvider,
    WorkflowReferenceService,
    WorkflowDraftEditor,
    WorkflowDefinitionService,
    WorkflowVersionPublisher,
    WorkflowEngineService,
    RuleContextBuilder,
    RuleContextContributorRegistry,
    CreateWorkflowCommand,
    UpdateWorkflowCommand,
    CreateWorkflowVersionCommand,
    GetWorkflowQuery,
    ListWorkflowsQuery,
    ListWorkflowVersionsQuery,
    GetWorkflowVersionQuery,
    WorkflowApplicabilityService,
    ResolveWorkflowQuery,
    SetDefaultWorkflowCommand,
    DefaultWorkflowsSeeder,
    CreateWorkflowStageCommand,
    UpdateWorkflowStageCommand,
    DeleteWorkflowStageCommand,
    CreateWorkflowTransitionCommand,
    UpdateWorkflowTransitionCommand,
    DeleteWorkflowTransitionCommand,
    CreateWorkflowRuleCommand,
    UpdateWorkflowRuleCommand,
    DeleteWorkflowRuleCommand,
    RuleTestProcessSourceRegistry,
    TestWorkflowRuleQuery,
    GetRuleContextSchemaQuery,
    ValidateWorkflowVersionQuery,
    PublishWorkflowVersionCommand,
    RetireWorkflowVersionCommand,
    PrismaWorkflowRepository,
    PrismaWorkflowTransactions,
    InMemoryWorkflowRepository,
    InMemoryWorkflowTransactions,
    {
      provide: WORKFLOW_REPOSITORY,
      inject: [APP_CONFIG, PrismaWorkflowRepository, InMemoryWorkflowRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaWorkflowRepository,
        memory: InMemoryWorkflowRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: WORKFLOW_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaWorkflowTransactions, InMemoryWorkflowTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaWorkflowTransactions,
        memory: InMemoryWorkflowTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: WORKFLOW_CLOCK, useValue: () => new Date() },
  ],
  exports: [WorkflowFacade],
})
export class WorkflowModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly defaultWorkflows: DefaultWorkflowsSeeder,
  ) {}

  /** Seeder `workflow.seedWorkflows` no checklist de provisionamento (US-099 · US-042). */
  onModuleInit(): void {
    this.seeders.register(this.defaultWorkflows);
  }
}
