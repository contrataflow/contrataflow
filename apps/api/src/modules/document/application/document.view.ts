import type { DocumentAction, DocumentDto } from '@contrataflow/validation';

import type { DocumentType } from '../domain/document-type.js';
import type { Document } from '../domain/document.js';

/*
 * Apresentação do `Document` (DOC-03/04/09/10/12/13 · api/03-documents.md): datas ISO 8601 UTC e o
 * resumo do tipo. `meta.allowedActions` acompanha o recurso (api.md §1.5).
 */

export interface DocumentView {
  readonly data: DocumentDto;
  readonly meta: { readonly allowedActions: DocumentAction[] };
}

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

export function toDocumentDto(document: Document, type: DocumentType): DocumentDto {
  return {
    id: document.id,
    processId: document.processId,
    documentType: {
      id: type.id,
      code: type.code,
      name: type.name,
      kind: type.kind,
      systemModule: type.systemModule,
      requiresApproval: type.requiresApproval,
    },
    templateVersionId: document.templateVersionId,
    number: document.number,
    year: document.year,
    code: document.code,
    title: document.title,
    status: document.status,
    confidentiality: document.confidentiality,
    draftContent: document.draftContent,
    draftRevision: document.draftRevision,
    currentVersionId: document.currentVersionId,
    currentVersionNumber: document.currentVersionNumber,
    approvedVersionId: document.approvedVersionId,
    pendingApprovalId: document.pendingApprovalId,
    responsibleId: document.responsibleId,
    submittedAt: iso(document.submittedAt),
    submittedById: document.submittedById,
    finalizedAt: iso(document.finalizedAt),
    finalizedById: document.finalizedById,
    approvedAt: iso(document.approvedAt),
    returnedAt: iso(document.returnedAt),
    rejectedAt: iso(document.rejectedAt),
    reopenedAt: iso(document.reopenedAt),
    reopenedById: document.reopenedById,
    reopenReason: document.reopenReason,
    canceledAt: iso(document.canceledAt),
    canceledById: document.canceledById,
    cancellationReason: document.cancellationReason,
    sourceDocumentId: document.sourceDocumentId,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    createdById: document.createdById,
    version: document.version,
  };
}
