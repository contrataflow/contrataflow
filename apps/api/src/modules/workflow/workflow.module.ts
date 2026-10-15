import { Module } from '@nestjs/common';

import { DocumentTypeUsageModule } from '#shared/document/document-type-usage.js';

import { WorkflowDocumentTypeUsageProvider } from './application/workflow-document-type-usage.provider.js';
import { WorkflowFacade } from './application/workflow.facade.js';

/**
 * Módulo `workflow` (DEC-040): outros módulos usam somente a fachada exportada. Implementa a porta
 * de uso de tipos de documento (`DocumentTypeUsageProvider` — US-061).
 */
@Module({
  imports: [DocumentTypeUsageModule],
  providers: [WorkflowFacade, WorkflowDocumentTypeUsageProvider],
  exports: [WorkflowFacade],
})
export class WorkflowModule {}
