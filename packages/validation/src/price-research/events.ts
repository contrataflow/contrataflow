import { z } from 'zod';

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
