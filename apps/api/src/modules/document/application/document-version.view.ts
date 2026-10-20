import type {
  DocumentKind,
  DocumentSnapshot,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
} from '@contrataflow/validation';

import type { DocumentVersionRecord } from '../domain/document-snapshot.js';

/*
 * Apresentação de `DocumentVersion` (DOC-15/16/17/18 · US-066): datas ISO 8601 UTC e o nome do
 * autor. O `content` chega aqui já mascarado conforme POL-09 por quem chama.
 */

export function toDocumentVersionSummaryDto(
  version: DocumentVersionRecord,
  authorNames: ReadonlyMap<string, string>,
): DocumentVersionSummaryDto {
  return {
    id: version.id,
    documentId: version.documentId,
    processId: version.processId,
    versionNumber: version.versionNumber,
    reason: version.reason,
    statusAtCreation: version.statusAtCreation,
    contentHash: version.contentHash,
    attachmentId: version.attachmentId,
    templateVersionId: version.templateVersionId,
    changeSummary: version.changeSummary,
    createdById: version.createdById,
    createdByName: authorNames.get(version.createdById) ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}

export function toDocumentVersionDto(
  version: DocumentVersionRecord,
  kind: DocumentKind,
  content: DocumentSnapshot | null,
  authorNames: ReadonlyMap<string, string>,
): DocumentVersionDto {
  return { ...toDocumentVersionSummaryDto(version, authorNames), kind, content };
}
