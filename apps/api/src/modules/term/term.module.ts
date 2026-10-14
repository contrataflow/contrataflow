import { Module } from '@nestjs/common';

import { TermFacade } from './application/term.facade.js';

/** Módulo `term` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [TermFacade],
  exports: [TermFacade],
})
export class TermModule {}
