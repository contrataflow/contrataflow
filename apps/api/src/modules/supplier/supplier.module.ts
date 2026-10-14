import { Module } from '@nestjs/common';

import { SupplierFacade } from './application/supplier.facade.js';

/** Módulo `supplier` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [SupplierFacade],
  exports: [SupplierFacade],
})
export class SupplierModule {}
