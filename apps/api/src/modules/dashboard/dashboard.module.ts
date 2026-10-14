import { Module } from '@nestjs/common';

import { DashboardFacade } from './application/dashboard.facade.js';

/** Módulo `dashboard` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [DashboardFacade],
  exports: [DashboardFacade],
})
export class DashboardModule {}
