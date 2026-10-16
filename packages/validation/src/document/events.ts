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

/**
 * `TemplateVersionPublished` (events.md §4.5 · US-108): commit da publicação (TPL-10). A versão
 * passa a corrente do template; o conteúdo é imutável e identificado por `contentHash`.
 */
export const TemplateVersionPublished = defineDomainEvent({
  eventType: 'TemplateVersionPublished',
  eventVersion: 1,
  aggregateType: 'DocumentTemplate',
  payload: z.strictObject({
    templateId: z.uuid(),
    templateVersionId: z.uuid(),
    versionNumber: z.number().int().min(1),
    documentTypeCode: z.string().min(1).max(40),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  routingKey: 'template.version_published',
});

/** `TemplateVersionRetired` (events.md §4.5 · US-108): commit da aposentadoria (TPL-11). */
export const TemplateVersionRetired = defineDomainEvent({
  eventType: 'TemplateVersionRetired',
  eventVersion: 1,
  aggregateType: 'DocumentTemplate',
  payload: z.strictObject({ templateId: z.uuid(), templateVersionId: z.uuid() }),
  routingKey: 'template.version_retired',
});
