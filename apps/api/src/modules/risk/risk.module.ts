import { Module } from '@nestjs/common';

import { RiskFacade } from './application/risk.facade.js';

/** Módulo `risk` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [RiskFacade],
  exports: [RiskFacade],
})
export class RiskModule {}
