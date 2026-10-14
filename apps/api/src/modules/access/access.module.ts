import { Module } from '@nestjs/common';

import { AccessFacade } from './application/access.facade.js';

/** Módulo `access` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [AccessFacade],
  exports: [AccessFacade],
})
export class AccessModule {}
