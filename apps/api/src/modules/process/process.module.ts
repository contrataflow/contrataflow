import { Module } from '@nestjs/common';

import { ProcessFacade } from './application/process.facade.js';

/** Módulo `process` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [ProcessFacade],
  exports: [ProcessFacade],
})
export class ProcessModule {}
