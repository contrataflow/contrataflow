import type {
  DocumentCancel,
  DocumentDto,
  DocumentMeta,
  DocumentReopen,
  DocumentTransition,
  DocumentValidationDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import type { IdempotentContext } from '@/lib/api/use-idempotent-mutation';
import { tenantKey } from '@/lib/query/keys';

/*
 * Ciclo de vida do documento (US-065 · SCR-105): DOC-03/08/09/10/12/13/14 de api/03-documents.md.
 * Chaves `['t', tenantId, 'documents', id, …]` (RN-FND-90). Toda escrita leva a `version` lida no
 * detalhe em `If-Match` (`ETag: "<version>"`); finalizar e submeter também levam `Idempotency-Key`.
 */

export const documentKeys = {
  /** Tudo do documento: detalhe e validação. */
  all: (tenantId: string, documentId: string) => tenantKey(tenantId, 'documents', documentId),
  /** DOC-03: `['t', tenantId, 'documents', id, 'detail']`. */
  detail: (tenantId: string, documentId: string) =>
    tenantKey(tenantId, 'documents', documentId, 'detail'),
  /** DOC-08: `['t', tenantId, 'documents', id, 'validation']`. */
  validation: (tenantId: string, documentId: string) =>
    tenantKey(tenantId, 'documents', documentId, 'validation'),
};

/** Documento e as ações permitidas (`meta.allowedActions` — a UI nunca recalcula a regra). */
export interface DocumentResult {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
}

function toResult(result: ApiResult<DocumentDto>): DocumentResult {
  const meta = result.meta as Partial<DocumentMeta>;
  return { document: result.data, meta: { allowedActions: meta.allowedActions ?? [] } };
}

/** `If-Match` com a `version` lida no detalhe. */
const ifMatchOf = (version: number) => `"${String(version)}"`;

/** DOC-03. */
export async function fetchDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentResult> {
  return toResult(await apiRequest<DocumentDto>(`/documents/${documentId}`, { signal }));
}

/** DOC-08: completude genérica + regras do módulo tipado num único `violations[]`. */
export async function fetchDocumentValidation(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentValidationDto> {
  return (
    await apiRequest<DocumentValidationDto>(`/documents/${documentId}/validation`, { signal })
  ).data;
}

/** DOC-10 (`finalize`) e DOC-09 (`submit`); a mesma chave vale para cada repetição da intenção. */
export async function transitionDocument(
  documentId: string,
  action: 'finalize' | 'submit',
  body: DocumentTransition,
  version: number,
  context: IdempotentContext,
): Promise<DocumentResult> {
  return toResult(
    await apiRequest<DocumentDto>(`/documents/${documentId}/${action}`, {
      method: 'POST',
      body,
      ifMatch: ifMatchOf(version),
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    }),
  );
}

/** DOC-12. */
export async function reopenDocument(
  documentId: string,
  body: DocumentReopen,
  version: number,
): Promise<DocumentResult> {
  return toResult(
    await apiRequest<DocumentDto>(`/documents/${documentId}/reopen`, {
      method: 'POST',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** DOC-13. */
export async function cancelDocument(
  documentId: string,
  body: DocumentCancel,
  version: number,
): Promise<DocumentResult> {
  return toResult(
    await apiRequest<DocumentDto>(`/documents/${documentId}/cancel`, {
      method: 'POST',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
}

/** DOC-14: 204 sem corpo. */
export async function deleteDocument(documentId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/documents/${documentId}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(version),
  });
}

/** Rota do painel do processo, aba "Documentos" (destino após excluir o rascunho). */
export function processDocumentsHref(processId: string): string {
  return `/processos/${processId}?aba=documentos`;
}
