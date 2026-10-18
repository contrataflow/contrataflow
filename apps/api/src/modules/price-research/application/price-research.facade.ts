import { Injectable } from '@nestjs/common';

/**
 * API pública do módulo `price-research` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório. US-024: nenhum consumidor ainda (o `RuleContext` de
 * `priceResearch.*` e o vínculo com o ETP chegam com US-029/US-032).
 */
@Injectable()
export class PriceResearchFacade {}
