import { Module } from '@nestjs/common';

import { AuditFacade } from './application/audit.facade.js';

/** Módulo `audit` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [AuditFacade],
  exports: [AuditFacade],
})
export class AuditModule {}
