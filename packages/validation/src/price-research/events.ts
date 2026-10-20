import { z } from 'zod';

import { EXCLUSION_REASONS } from './price-sources.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * `PriceResearchRecalculated` (events.md §4 · US-024/US-029): commit de PRS-04 (data-base), PRS-06
 * (inclusão de itens) e PRS-08 (remoção de item) — e, com US-029, de todo recálculo. Só ids e
 * contadores: nunca preços, totais nem descrições (DEC-030).
 */
export const PriceResearchRecalculated = defineDomainEvent({
  eventType: 'PriceResearchRecalculated',
  eventVersion: 1,
  aggregateType: 'PriceResearch',
  payload: z.strictObject({
    priceResearchId: z.uuid(),
    itemsCount: z.int().min(0),
    itemsWithAlertsCount: z.int().min(0),
  }),
  routingKey: 'price_research.recalculated',
});

/**
 * `QuotationExcluded` (events.md §4 · US-027 · PRS-16): commit da desconsideração de uma cotação.
 * Só ids e o código do motivo — nunca a justificativa (texto livre), preços nem descrições (DEC-030).
 */
export const QuotationExcluded = defineDomainEvent({
  eventType: 'QuotationExcluded',
  eventVersion: 1,
  aggregateType: 'Quotation',
  payload: z.strictObject({
    priceResearchId: z.uuid(),
    quotationId: z.uuid(),
    priceItemId: z.uuid(),
    reason: z.enum(EXCLUSION_REASONS),
  }),
  routingKey: 'price_research.quotation_excluded',
});

/** `QuotationRestored` (events.md §4 · US-027 · PRS-17): commit da restauração de uma cotação. */
export const QuotationRestored = defineDomainEvent({
  eventType: 'QuotationRestored',
  eventVersion: 1,
  aggregateType: 'Quotation',
  payload: z.strictObject({
    priceResearchId: z.uuid(),
    quotationId: z.uuid(),
    priceItemId: z.uuid(),
  }),
  routingKey: 'price_research.quotation_restored',
});
