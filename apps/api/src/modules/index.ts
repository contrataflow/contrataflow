import { AccessModule } from './access/access.module.js';
import { ApprovalModule } from './approval/approval.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CollaborationModule } from './collaboration/collaboration.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DfdModule } from './dfd/dfd.module.js';
import { DocumentModule } from './document/document.module.js';
import { EtpModule } from './etp/etp.module.js';
import { FilesModule } from './files/files.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { InboxModule } from './inbox/inbox.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PriceResearchModule } from './price-research/price-research.module.js';
import { ProcessModule } from './process/process.module.js';
import { RiskModule } from './risk/risk.module.js';
import { SupplierModule } from './supplier/supplier.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { TermModule } from './term/term.module.js';
import { TimelineModule } from './timeline/timeline.module.js';
import { WorkflowModule } from './workflow/workflow.module.js';

/**
 * Todos os módulos de DEC-040 (RN-FND-29), na ordem dos níveis de `tools/module-levels.json`.
 * Um teste garante que a lista e as pastas de `src/modules` não divergem.
 */
export const API_MODULES = [
  PlatformModule,
  TenancyModule,
  OrganizationModule,
  IdentityModule,
  AccessModule,
  CatalogModule,
  AuditModule,
  WorkflowModule,
  DocumentModule,
  FilesModule,
  ApprovalModule,
  SupplierModule,
  ProcessModule,
  DfdModule,
  EtpModule,
  TermModule,
  PriceResearchModule,
  RiskModule,
  CollaborationModule,
  TimelineModule,
  InboxModule,
  DashboardModule,
  NotificationModule,
] as const;
