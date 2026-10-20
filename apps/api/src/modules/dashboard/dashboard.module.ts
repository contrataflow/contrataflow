import { Module } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';

import { DashboardCache } from './application/dashboard-cache.js';
import { DashboardContextResolver } from './application/dashboard-context.resolver.js';
import { DashboardWidgetRegistry } from './application/dashboard-widgets.js';
import { DashboardFacade } from './application/dashboard.facade.js';
import {
  DashboardQueryInstrumentation,
  DashboardQuerySupport,
  GetDashboardSummaryHandler,
  GetDashboardWidgetHandler,
} from './application/dashboard.queries.js';
import { DASHBOARD_CLOCK, DASHBOARD_READER, DASHBOARD_TRANSACTIONS } from './application/ports.js';
import type { DashboardClock } from './application/ports.js';
import {
  InMemoryDashboardReader,
  InMemoryDashboardTransactions,
  PrismaDashboardReader,
  PrismaDashboardTransactions,
} from './infrastructure/dashboard.readers.js';
import { DashboardController } from './presentation/dashboard.controller.js';
import { AccessModule } from '../access/access.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

/**
 * Módulo `dashboard` (DEC-040, nível 5): outros módulos usam somente a fachada exportada. Sem
 * entidades — US-076: DSH-01/DSH-02 agregam as views `v_dashboard_*` publicadas por `process` e
 * `timeline` sob a visibilidade única (DEC-024), com nomes pelas fachadas donas e os contadores de
 * TSK-02 pela `InboxFacade` (exceção de nível registrada em DEC-088).
 */
@Module({
  imports: [
    AccessModule,
    CatalogModule,
    InboxModule,
    OrganizationModule,
    TenancyModule,
    WorkflowModule,
  ],
  controllers: [DashboardController],
  providers: [
    DashboardFacade,
    DashboardCache,
    DashboardContextResolver,
    DashboardWidgetRegistry,
    DashboardQueryInstrumentation,
    DashboardQuerySupport,
    GetDashboardSummaryHandler,
    GetDashboardWidgetHandler,
    PrismaDashboardReader,
    PrismaDashboardTransactions,
    {
      provide: DASHBOARD_READER,
      inject: [APP_CONFIG, PrismaDashboardReader],
      // Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): leitor em memória.
      useFactory: (config: AppConfig, prisma: PrismaDashboardReader) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryDashboardReader(),
    },
    {
      provide: DASHBOARD_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaDashboardTransactions],
      useFactory: (config: AppConfig, prisma: PrismaDashboardTransactions) =>
        config.oidc.fakeSigningKey === null ? prisma : new InMemoryDashboardTransactions(),
    },
    { provide: DASHBOARD_CLOCK, useValue: (() => new Date()) satisfies DashboardClock },
  ],
  exports: [DashboardFacade],
})
export class DashboardModule {}
