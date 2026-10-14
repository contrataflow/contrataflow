import { Module } from '@nestjs/common';

import { DfdFacade } from './application/dfd.facade.js';

/** Módulo `dfd` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [DfdFacade],
  exports: [DfdFacade],
})
export class DfdModule {}
