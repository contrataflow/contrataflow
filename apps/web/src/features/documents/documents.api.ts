import type {
  DocumentAiReview,
  DocumentAiReviewResultDto,
  DocumentCancel,
  DocumentDto,
  DocumentMeta,
  DocumentReopen,
  DocumentTransition,
  DocumentValidationDto,
  DocumentVersionComparisonDto,
  DocumentVersionCreate,
  DocumentVersionDto,
  DocumentVersionSummaryDto,
  PageMeta,
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

/**
 * Versões imutáveis (US-066 · SCR-106): `['t', tenantId, 'documents', id, 'versions', …]` — dentro
 * de `documentKeys.all`, então invalidar o documento também renova a lista.
 */
export const versionKeys = {
  /** DOC-15 (todas as páginas). */
  list: (tenantId: string, documentId: string) =>
    tenantKey(tenantId, 'documents', documentId, 'versions'),
  /** DOC-18. */
  compare: (tenantId: string, documentId: string, from: string, to: string) =>
    tenantKey(tenantId, 'documents', documentId, 'versions', 'compare', from, to),
};

/**
 * Documento e as ações permitidas (`meta.allowedActions` — a UI nunca recalcula a regra); o DOC-02 e
 * o DOC-03 trazem também `meta.template` (seções do template fixado — US-063).
 */
export interface DocumentResult {
  readonly document: DocumentDto;
  readonly meta: DocumentMeta;
}

function toResult(result: ApiResult<DocumentDto>): DocumentResult {
  return { document: result.data, meta: documentMetaOf(result.meta) };
}

/** `meta` da resposta: as ações e, quando vier (DOC-02/03), o template fixado no documento. */
export function documentMetaOf(raw: unknown): DocumentMeta {
  const meta = (raw ?? {}) as Partial<DocumentMeta>;
  return {
    allowedActions: meta.allowedActions ?? [],
    ...(meta.template === undefined ? {} : { template: meta.template }),
  };
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

/**
 * DOC-27 (US-122): marca seções geradas por IA como revisadas. A concorrência é por seção
 * (`expectedRevisions` no corpo — sem `If-Match`); seção já revisada é ignorada (idempotente).
 */
export async function reviewAiContent(
  documentId: string,
  body: DocumentAiReview,
): Promise<DocumentAiReviewResultDto> {
  return (
    await apiRequest<DocumentAiReviewResultDto>(`/documents/${documentId}/ai-review`, {
      method: 'POST',
      body,
    })
  ).data;
}

/** Rota do painel do processo, aba "Documentos" (destino após excluir o rascunho). */
export function processDocumentsHref(processId: string): string {
  return `/processos/${processId}?aba=documentos`;
}

// --- Versões (US-066 · DOC-15/16/18) ---------------------------------------------------------

/** Lista de versões (`versionNumber` desc) com a paginação. */
export interface DocumentVersionPage {
  readonly items: readonly DocumentVersionSummaryDto[];
  readonly meta: PageMeta;
}

/** DOC-15: até 100 versões por página (o histórico de um documento administrativo é curto). */
export async function fetchDocumentVersions(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentVersionPage> {
  const result = await apiRequest<DocumentVersionSummaryDto[]>(
    `/documents/${documentId}/versions?page=1&pageSize=100`,
    { signal },
  );
  return { items: result.data, meta: result.meta as unknown as PageMeta };
}

/** DOC-16: "Salvar versão" com `Idempotency-Key` (sem `If-Match`). */
export async function saveDocumentVersion(
  documentId: string,
  body: DocumentVersionCreate,
  context: IdempotentContext,
): Promise<DocumentVersionDto> {
  return (
    await apiRequest<DocumentVersionDto>(`/documents/${documentId}/versions`, {
      method: 'POST',
      body,
      idempotencyKey: context.idempotencyKey,
      correlationId: context.correlationId,
    })
  ).data;
}

/** DOC-18: diferenças entre duas versões do documento (POL-09 aplicado pela API). */
export async function compareDocumentVersions(
  documentId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<DocumentVersionComparisonDto> {
  const query = new URLSearchParams({ from, to }).toString();
  return (
    await apiRequest<DocumentVersionComparisonDto>(
      `/documents/${documentId}/versions/compare?${query}`,
      { signal },
    )
  ).data;
}

/** SCR-106: `/processos/{id}/documentos/{docId}/versoes`. */
export function documentVersionsHref(processId: string, documentId: string): string {
  return `/processos/${processId}/documentos/${documentId}/versoes`;
}
