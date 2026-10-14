import { Module } from '@nestjs/common';

import { OrganizationFacade } from './application/organization.facade.js';

/** Módulo `organization` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [OrganizationFacade],
  exports: [OrganizationFacade],
})
export class OrganizationModule {}
