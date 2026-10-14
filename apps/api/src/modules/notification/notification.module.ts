import { Module } from '@nestjs/common';

import { NotificationFacade } from './application/notification.facade.js';

/** Módulo `notification` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [NotificationFacade],
  exports: [NotificationFacade],
})
export class NotificationModule {}
