import { AI_TARGET_MODULES } from '@contrataflow/types';
import { z } from 'zod';

import { RENDITION_KINDS } from './document-rendition.js';
import { DOCUMENT_KINDS, DOCUMENT_STATUSES } from './document-type.js';
import { VERSION_REASONS } from './document.js';
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

// --- Documentos (events.md §4.3 · US-065) -------------------------------------------------------

/*
 * Eventos genéricos de documento: todos levam `documentTypeCode`, e a routing key é
 * `document.<fato>.<tipo_em_minúsculas>` (DEC-162) — `DFDCreated` = `DocumentCreated` com
 * `document.created.dfd`, nunca outra linha (RN-FND-51). Payload só com IDs e o mínimo (events.md
 * §1): nada de conteúdo de seção nem de justificativa.
 */

const documentTypeCode = z.string().min(1).max(40);
const documentStatus = z.enum(DOCUMENT_STATUSES);

function documentRoutingKey(fact: string) {
  return (payload: { readonly documentTypeCode: string }) =>
    `document.${fact}.${payload.documentTypeCode.toLowerCase()}`;
}

/** `DocumentCreated` — criação do documento (fábrica única da US-065; DOC-02 na US-063/064). */
export const DocumentCreated = defineDomainEvent({
  eventType: 'DocumentCreated',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    kind: z.enum(DOCUMENT_KINDS),
    code: z.string().min(1).max(60).nullable(),
    title: z.string().min(1).max(250),
    templateVersionId: z.uuid().nullable(),
    sourceDocumentId: z.uuid().nullable(),
  }),
  routingKey: documentRoutingKey('created'),
});

/** `DocumentVersionCreated` — toda transição que cria versão (RN-DOC-53). */
export const DocumentVersionCreated = defineDomainEvent({
  eventType: 'DocumentVersionCreated',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    documentVersionId: z.uuid(),
    versionNumber: z.int().min(1),
    reason: z.enum(VERSION_REASONS),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  routingKey: documentRoutingKey('version_created'),
});

/** `DocumentSubmitted` — DOC-09 ou entrada em etapa de aprovação (RN-DOC-43/44). */
export const DocumentSubmitted = defineDomainEvent({
  eventType: 'DocumentSubmitted',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    documentVersionId: z.uuid(),
    approvalId: z.uuid().nullable(),
  }),
  routingKey: documentRoutingKey('submitted'),
});

/** `DocumentFinalized` — DOC-10 (RN-DOC-42); `typedSummary` só para `STRUCTURED` (RN-DOC-52). */
export const DocumentFinalized = defineDomainEvent({
  eventType: 'DocumentFinalized',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    documentVersionId: z.uuid(),
    typedSummary: z.record(z.string(), z.unknown()).optional(),
  }),
  routingKey: documentRoutingKey('finalized'),
});

/** `DocumentApproved` — decisão `APPROVED` (RN-DOC-45, aplicada pelo módulo de aprovações). */
export const DocumentApproved = defineDomainEvent({
  eventType: 'DocumentApproved',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    documentVersionId: z.uuid(),
    approvalId: z.uuid(),
  }),
  routingKey: documentRoutingKey('approved'),
});

/** `DocumentReturned` — decisão `RETURNED` (RN-DOC-45). */
export const DocumentReturned = defineDomainEvent({
  eventType: 'DocumentReturned',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({ documentId: z.uuid(), documentTypeCode, approvalId: z.uuid() }),
  routingKey: documentRoutingKey('returned'),
});

/** `DocumentRejected` — decisão `REJECTED` (RN-DOC-45). */
export const DocumentRejected = defineDomainEvent({
  eventType: 'DocumentRejected',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({ documentId: z.uuid(), documentTypeCode, approvalId: z.uuid() }),
  routingKey: documentRoutingKey('rejected'),
});

/** `DocumentReopened` — DOC-12 (RN-DOC-47); `baseVersionId` = versão de onde nasce o rascunho. */
export const DocumentReopened = defineDomainEvent({
  eventType: 'DocumentReopened',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentTypeCode,
    fromStatus: documentStatus,
    baseVersionId: z.uuid().nullable(),
  }),
  routingKey: documentRoutingKey('reopened'),
});

/** `DocumentCanceled` — DOC-13 (RN-DOC-48). */
export const DocumentCanceled = defineDomainEvent({
  eventType: 'DocumentCanceled',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({ documentId: z.uuid(), documentTypeCode, fromStatus: documentStatus }),
  routingKey: documentRoutingKey('canceled'),
});

/**
 * `AiContentReviewed` — DOC-27 (US-122 · RN-AI-56) e RSK-12 (US-119): revisão humana do conteúdo
 * gerado por IA (events.md §4.7). Só ids e contagens — nunca o texto. Routing key
 * `document.ai_content_reviewed.<tipo>` (`dfd`, `etp`, `risk_map`, `tr`). Projeta
 * `AI_CONTENT_REVIEWED` na timeline.
 */
export const AiContentReviewed = defineDomainEvent({
  eventType: 'AiContentReviewed',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({
    documentId: z.uuid().nullable(),
    documentTypeCode,
    targetModule: z.enum(AI_TARGET_MODULES).nullable(),
    sectionKeys: z.array(z.string().min(1).max(60)),
    riskIds: z.array(z.uuid()),
    generationIds: z.array(z.uuid()),
  }),
  routingKey: documentRoutingKey('ai_content_reviewed'),
});

/** `TemplateVersionRetired` (events.md §4.5 · US-108): commit da aposentadoria (TPL-11). */
export const TemplateVersionRetired = defineDomainEvent({
  eventType: 'TemplateVersionRetired',
  eventVersion: 1,
  aggregateType: 'DocumentTemplate',
  payload: z.strictObject({ templateId: z.uuid(), templateVersionId: z.uuid() }),
  routingKey: 'template.version_retired',
});

// --- PDFs (events.md §4.3 · US-067) -------------------------------------------------------------

const renditionKind = z.enum(RENDITION_KINDS);

/**
 * `DocumentRenditionReady` — o worker `document-render` gravou o PDF (RN-DOC-65). Agregado =
 * `DocumentRendition` (routing key fixa, sem o tipo do documento: o consumidor é a central de
 * notificações — US-111).
 */
export const DocumentRenditionReady = defineDomainEvent({
  eventType: 'DocumentRenditionReady',
  eventVersion: 1,
  aggregateType: 'DocumentRendition',
  payload: z.strictObject({
    documentId: z.uuid(),
    documentVersionId: z.uuid().nullable(),
    renditionId: z.uuid(),
    kind: renditionKind,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageCount: z.int().min(1),
  }),
  routingKey: 'document.rendition_ready',
});

/** `DocumentRenditionFailed` — tentativas esgotadas ou falha permanente (RN-DOC-67). */
export const DocumentRenditionFailed = defineDomainEvent({
  eventType: 'DocumentRenditionFailed',
  eventVersion: 1,
  aggregateType: 'DocumentRendition',
  payload: z.strictObject({
    documentId: z.uuid(),
    renditionId: z.uuid(),
    kind: renditionKind,
    errorCode: z.string().min(1).max(60),
    attempts: z.int().min(0),
  }),
  routingKey: 'document.rendition_failed',
});
