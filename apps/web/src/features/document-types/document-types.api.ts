import type {
  DocumentTypeCreate,
  DocumentTypeDto,
  DocumentTypeUpdate,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Tipos de documento (US-061 · SCR-108): DTY-01..03 de api/03-documents.md. As chaves seguem a
 * convenção `['t', tenantId, …]` (RN-FND-90); a lista do SCR-108 sempre pede `includeInactive`.
 */

export const documentTypeKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'document-types'),
  list: (tenantId: string, includeInactive = true) =>
    tenantKey(tenantId, 'document-types', { includeInactive }),
};

/** Staleness da lista administrativa (architecture.md §8.5: catálogos e configurações). */
export const DOCUMENT_TYPES_STALE_TIME_MS = 5 * 60_000;

export function fetchDocumentTypes(signal?: AbortSignal): Promise<ApiResult<DocumentTypeDto[]>> {
  return apiRequest<DocumentTypeDto[]>('/document-types', {
    query: { includeInactive: true },
    signal,
  });
}

/** DTY-02: `Idempotency-Key` da intenção do usuário (reenvio após falha de rede — FA-06). */
export function createDocumentType(
  body: DocumentTypeCreate,
  context: IdempotentContext,
): Promise<ApiResult<DocumentTypeDto>> {
  return apiRequest<DocumentTypeDto>('/document-types', {
    method: 'POST',
    body,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId,
  });
}

/** DTY-03: só os campos alterados, com a versão lida em `If-Match`. */
export function updateDocumentType(
  id: string,
  patch: DocumentTypeUpdate,
  version: number,
): Promise<ApiResult<DocumentTypeDto>> {
  return apiRequest<DocumentTypeDto>(`/document-types/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}
