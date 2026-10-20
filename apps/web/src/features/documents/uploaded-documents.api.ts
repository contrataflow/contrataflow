import type {
  DocumentCreate,
  DocumentDto,
  DocumentUploadVersion,
  DocumentVersionDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';

import { documentMetaOf } from './documents.api';
import type { DocumentResult } from './documents.api';

/*
 * Documento externo (US-064 · SCR-105): DOC-02 cria a casca `UPLOADED` (sem versão), DOC-19 vira o
 * anexo `AVAILABLE` (ATT-02 → PUT → ATT-03 → varredura) na nova versão — com `If-Match` da versão
 * lida do documento e `Idempotency-Key` por intenção (o reenvio não duplica a versão — FA-05) — e
 * DOC-17 traz a versão corrente (autor, data e o anexo da prévia).
 */

/** DOC-02. */
export async function createProcessDocument(
  processId: string,
  body: DocumentCreate,
  context: IdempotentContext,
): Promise<DocumentResult> {
  const result = await apiRequest<DocumentDto>(`/processes/${processId}/documents`, {
    method: 'POST',
    body,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
  return { document: result.data, meta: documentMetaOf(result.meta) };
}

/** DOC-19. */
export async function uploadDocumentVersion(
  documentId: string,
  body: DocumentUploadVersion,
  version: number,
  idempotencyKey: string,
): Promise<DocumentVersionDto> {
  return (
    await apiRequest<DocumentVersionDto>(`/documents/${documentId}/upload-version`, {
      method: 'POST',
      body,
      ifMatch: `"${String(version)}"`,
      idempotencyKey,
    })
  ).data;
}

/** DOC-17. */
export async function fetchDocumentVersion(
  versionId: string,
  signal?: AbortSignal,
): Promise<DocumentVersionDto> {
  return (await apiRequest<DocumentVersionDto>(`/document-versions/${versionId}`, { signal })).data;
}
