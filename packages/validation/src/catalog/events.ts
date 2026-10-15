import { CATALOG_ITEM_CHANGES, CATALOG_TYPES } from '@contrataflow/types';
import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * `CatalogItemChanged` (events.md §4.5 · US-104): um evento por item afetado no commit de criar,
 * editar, ativar, desativar ou reordenar (a reordenação emite `UPDATED` para cada item cuja
 * posição mudou). Consumido pelo `ConfigCacheInvalidator` (legenda C).
 */
export const CatalogItemChanged = defineDomainEvent({
  eventType: 'CatalogItemChanged',
  eventVersion: 1,
  aggregateType: 'CatalogItem',
  payload: z.strictObject({
    catalogType: z.enum(CATALOG_TYPES),
    catalogItemId: z.uuid(),
    code: z.string().min(1).max(60),
    change: z.enum(CATALOG_ITEM_CHANGES),
  }),
  routingKey: 'catalog.item_changed',
});
