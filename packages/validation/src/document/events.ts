import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/**
 * `DocumentTypeChanged` (events.md §4 · US-061): criação, edição e ativação/desativação de um
 * `DocumentType`. Consumidor: invalidação do cache de tipos (`ConfigCacheInvalidator`).
 */
export const DocumentTypeChanged = defineDomainEvent({
  eventType: 'DocumentTypeChanged',
  eventVersion: 1,
  aggregateType: 'DocumentType',
  payload: z.strictObject({
    documentTypeId: z.uuid(),
    code: z.string().min(1).max(40),
    changedFields: z.array(z.string().min(1).max(60)).max(40),
  }),
  routingKey: 'document_type.changed',
});
