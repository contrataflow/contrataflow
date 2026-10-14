import { Module } from '@nestjs/common';

import { CatalogFacade } from './application/catalog.facade.js';

/** Módulo `catalog` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [CatalogFacade],
  exports: [CatalogFacade],
})
export class CatalogModule {}
