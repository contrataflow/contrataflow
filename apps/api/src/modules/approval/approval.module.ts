import { Module } from '@nestjs/common';

import { ApprovalFacade } from './application/approval.facade.js';

/** Módulo `approval` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [ApprovalFacade],
  exports: [ApprovalFacade],
})
export class ApprovalModule {}
