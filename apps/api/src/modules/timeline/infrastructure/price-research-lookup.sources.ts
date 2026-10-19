import { Injectable } from '@nestjs/common';

import { PriceResearchFacade } from '#modules/price-research/application/price-research.facade.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { TimelineLookupSource } from '../application/ports.js';
import type { TimelineLookupRecords } from '../domain/timeline-lookups.js';

/**
 * Fonte `PRICE_ITEM` (US-027): sequência do item da pesquisa, congelada nas entradas
 * `QUOTATION_EXCLUDED`/`QUOTATION_RESTORED` (RN-TML-04). Pela fachada do `price-research`, no `tx`
 * do caso de uso (RLS do tenant).
 */
@Injectable()
export class PriceItemLookupSource implements TimelineLookupSource<'PRICE_ITEM'> {
  readonly kind = 'PRICE_ITEM';

  constructor(private readonly priceResearch: PriceResearchFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['PRICE_ITEM']>> {
    return this.priceResearch.priceItemSequences(tx, ids);
  }
}

/** Fonte `QUOTATION` (US-027): rótulo da fonte da cotação, congelado na entrada (RN-TML-04). */
@Injectable()
export class QuotationLookupSource implements TimelineLookupSource<'QUOTATION'> {
  readonly kind = 'QUOTATION';

  constructor(private readonly priceResearch: PriceResearchFacade) {}

  lookup(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, TimelineLookupRecords['QUOTATION']>> {
    return this.priceResearch.quotationSourceLabels(tx, ids);
  }
}
