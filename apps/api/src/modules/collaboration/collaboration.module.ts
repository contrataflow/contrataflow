import { Module } from '@nestjs/common';

import { CollaborationFacade } from './application/collaboration.facade.js';

/** Módulo `collaboration` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [CollaborationFacade],
  exports: [CollaborationFacade],
})
export class CollaborationModule {}
