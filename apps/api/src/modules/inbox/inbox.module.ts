import { Module } from '@nestjs/common';

import { InboxFacade } from './application/inbox.facade.js';

/** Módulo `inbox` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [InboxFacade],
  exports: [InboxFacade],
})
export class InboxModule {}
