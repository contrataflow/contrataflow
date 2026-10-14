import { Module } from '@nestjs/common';

import { DocumentFacade } from './application/document.facade.js';

/** Módulo `document` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [DocumentFacade],
  exports: [DocumentFacade],
})
export class DocumentModule {}
