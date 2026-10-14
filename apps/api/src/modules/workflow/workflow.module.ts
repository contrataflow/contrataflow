import { Module } from '@nestjs/common';

import { WorkflowFacade } from './application/workflow.facade.js';

/** Módulo `workflow` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [WorkflowFacade],
  exports: [WorkflowFacade],
})
export class WorkflowModule {}
