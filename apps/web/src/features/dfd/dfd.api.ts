import { sectionEtag } from '@contrataflow/validation';
import type {
  DfdDto,
  DfdMeta,
  DfdPatch,
  DfdSummaryDto,
  DocumentItemDto,
  DocumentItemInput,
  DocumentSectionSave,
  DocumentSectionSavedDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * DFD (US-014 · SCR-007): DFD-01..03 de api/05-dfd.md e os itens do documento (DOC-06/07 de
 * api/03-documents.md). O id do DFD é o do documento. Chaves `['t', tenantId, 'dfds', id]` e
 * `['t', tenantId, 'documents', id, 'items']` (sob a do documento — a invalidação do documento
 * alcança os itens e a validação). O `ETag` dos itens é a versão do DOCUMENTO (`If-Match` do DOC-07).
 */

export const dfdKeys = {
  detail: (tenantId: string, dfdId: string) => tenantKey(tenantId, 'dfds', dfdId),
  ofProcess: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'dfds'),
  items: (tenantId: string, documentId: string) =>
    tenantKey(tenantId, 'documents', documentId, 'items'),
};

/** DFD e o `meta` (ações e a versão de template fixada). */
export interface DfdResult {
  readonly dfd: DfdDto;
  readonly meta: DfdMeta;
}

function toResult(result: ApiResult<DfdDto>): DfdResult {
  const meta = result.meta as Partial<DfdMeta>;
  return {
    dfd: result.data,
    meta: {
      allowedActions: meta.allowedActions ?? [],
      template: meta.template ?? null,
      // US-017: só o DFD-03 traz a decisão; as demais respostas a omitem.
      ...(meta.decision === undefined ? {} : { decision: meta.decision }),
    },
  };
}

function versionOf(etag: string | null): number {
  const parsed = Number((etag ?? '').replaceAll('"', '').replace(/^W\//, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

/** Rota da SCR-007 (o passo opcional em `?passo=`). */
export function dfdHref(processId: string, dfdId: string, step?: string): string {
  const base = `/processos/${processId}/dfd/${dfdId}`;
  return step === undefined ? base : `${base}?passo=${step}`;
}

/** DFD-02 (a mesma `Idempotency-Key` em cada repetição do clique — "Duplicidade"). */
export async function createDfd(
  processId: string,
  templateId: string | null,
  idempotencyKey: string,
): Promise<DfdResult> {
  return toResult(
    await apiRequest<DfdDto>(`/processes/${processId}/dfds`, {
      method: 'POST',
      body: templateId === null ? {} : { templateId },
      idempotencyKey,
    }),
  );
}

/** DFD-01. */
export async function fetchProcessDfds(
  processId: string,
  signal?: AbortSignal,
): Promise<DfdSummaryDto[]> {
  const result = await apiRequest<DfdSummaryDto[]>(`/processes/${processId}/dfds`, { signal });
  return Array.isArray(result.data) ? result.data : [];
}

/** DFD-03. */
export async function fetchDfd(dfdId: string, signal?: AbortSignal): Promise<DfdResult> {
  return toResult(await apiRequest<DfdDto>(`/dfds/${dfdId}`, { signal }));
}

export function useDfd(dfdId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dfdKeys.detail(tenantId, dfdId),
    queryFn: ({ signal }) => fetchDfd(dfdId, signal),
    throwOnError: false,
  });
}

/** Itens do documento com a versão do documento (`ETag`). */
export interface DocumentItemList {
  readonly items: readonly DocumentItemDto[];
  readonly documentVersion: number;
}

/** DOC-06. */
export async function fetchDocumentItems(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentItemList> {
  const result = await apiRequest<DocumentItemDto[]>(`/documents/${documentId}/items`, { signal });
  return {
    items: Array.isArray(result.data) ? result.data : [],
    documentVersion: versionOf(result.meta.etag),
  };
}

export function useDocumentItems(documentId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: dfdKeys.items(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocumentItems(documentId, signal),
    throwOnError: false,
  });
}

/** DOC-07: substitui a coleção inteira com `If-Match` da versão do documento. */
export async function replaceDocumentItems(
  documentId: string,
  items: readonly DocumentItemInput[],
  documentVersion: number,
): Promise<DocumentItemList> {
  const result = await apiRequest<DocumentItemDto[]>(`/documents/${documentId}/items`, {
    method: 'PUT',
    body: { items },
    ifMatch: `"${String(documentVersion)}"`,
  });
  return {
    items: Array.isArray(result.data) ? result.data : [],
    documentVersion: versionOf(result.meta.etag),
  };
}

/** DFD-04 (US-015): grava SÓ os campos alterados do cabeçalho com `If-Match` da versão do DFD. */
export async function patchDfd(
  dfdId: string,
  patch: DfdPatch,
  version: number,
): Promise<DfdResult> {
  return toResult(
    await apiRequest<DfdDto>(`/dfds/${dfdId}`, {
      method: 'PATCH',
      body: patch,
      ifMatch: `"${String(version)}"`,
    }),
  );
}

/** DOC-05 (US-015): grava a seção com `If-Match: "s<revision>"` (revisão da SEÇÃO). */
export async function saveDocumentSection(
  documentId: string,
  sectionKey: string,
  body: DocumentSectionSave,
  revision: number,
): Promise<DocumentSectionSavedDto> {
  const result = await apiRequest<DocumentSectionSavedDto>(
    `/documents/${documentId}/sections/${sectionKey}`,
    { method: 'PUT', body, ifMatch: sectionEtag(revision) },
  );
  return result.data;
}
