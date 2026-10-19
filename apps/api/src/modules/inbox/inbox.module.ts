import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { InboxViewerResolver } from './application/inbox-viewer.resolver.js';
import { InboxFacade } from './application/inbox.facade.js';
import { INBOX_CLOCK, INBOX_READER, INBOX_TRANSACTIONS } from './application/ports.js';
import type { InboxClock } from './application/ports.js';
import { TaskInboxPresenter } from './application/task-inbox.presenter.js';
import {
  GetTaskInboxCountersHandler,
  GetTaskInboxHandler,
  InboxQueryInstrumentation,
} from './application/task-inbox.queries.js';
import {
  InMemoryInboxReader,
  InMemoryInboxTransactions,
  PrismaInboxReader,
  PrismaInboxTransactions,
} from './infrastructure/task-inbox.readers.js';
import { TasksController } from './presentation/tasks.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ProcessModule } from '../process/process.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

/**
 * Módulo `inbox` (DEC-040, nível 5): outros módulos usam somente a fachada exportada. Sem
 * entidades — US-056: TSK-01/TSK-02 leem as views publicadas por `process` e `approval`
 * (DEC-026), com nomes e prazos pelas fachadas donas.
 */
@Module({
  imports: [
    AccessModule,
    IdentityModule,
    OrganizationModule,
    ProcessModule,
    TenancyModule,
    WorkflowModule,
  ],
  controllers: [TasksController],
  providers: [
    InboxFacade,
    GetTaskInboxHandler,
    GetTaskInboxCountersHandler,
    InboxQueryInstrumentation,
    InboxViewerResolver,
    TaskInboxPresenter,
    PrismaInboxReader,
    PrismaInboxTransactions,
    {
      provide: INBOX_READER,
      inject: [APP_CONFIG, PrismaInboxReader],
      // Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): leitor em memória.
      useFactory: (config: AppConfig, prisma: PrismaInboxReader) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryInboxReader(),
    },
    {
      provide: INBOX_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaInboxTransactions],
      useFactory: (config: AppConfig, prisma: PrismaInboxTransactions) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryInboxTransactions(),
    },
    { provide: INBOX_CLOCK, useValue: (() => new Date()) satisfies InboxClock },
  ],
  exports: [InboxFacade],
})
export class InboxModule {}
