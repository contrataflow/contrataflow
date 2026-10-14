import { Module } from '@nestjs/common';

import { EtpFacade } from './application/etp.facade.js';

/** Módulo `etp` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [EtpFacade],
  exports: [EtpFacade],
})
export class EtpModule {}
