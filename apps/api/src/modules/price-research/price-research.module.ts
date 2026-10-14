import { Module } from '@nestjs/common';

import { PriceResearchFacade } from './application/price-research.facade.js';

/** Módulo `price-research` (DEC-040): outros módulos usam somente a fachada exportada. */
@Module({
  providers: [PriceResearchFacade],
  exports: [PriceResearchFacade],
})
export class PriceResearchModule {}
