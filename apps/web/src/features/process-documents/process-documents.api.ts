import type {
  DocumentTypeDto,
  ProcessDocumentDto,
  ProcessDocumentsMeta,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Painel de documentos do processo (US-062 · SCR-006 aba "Documentos"): DOC-01 e DTY-01 de
 * api/03-documents.md, em paralelo. A lista fica sob a chave do processo
 * (`['t', tenantId, 'processes', id, 'documents']`): invalidar o painel do processo a renova. A
 * revalidação ao focar a janela traz o que outra sessão mudou (Concorrência) sem recarregar a página.
 */

export const processDocumentKeys = {
  list: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'documents'),
  /** Tipos ativos (DTY-01 sem `includeInactive`) — cacheados 10 min também no servidor. */
  activeTypes: (tenantId: string) =>
    tenantKey(tenantId, 'document-types', { includeInactive: false }),
};

/** O catálogo de tipos muda pouco (cache de 10 min na API — RN-DOC-12). */
export const ACTIVE_TYPES_STALE_TIME_MS = 5 * 60_000;

export interface ProcessDocumentsList {
  readonly items: readonly ProcessDocumentDto[];
  readonly meta: ProcessDocumentsMeta;
}

const EMPTY_META: ProcessDocumentsMeta = {
  currentStage: null,
  creatableTypeIds: [],
  pendingTypeIds: [],
};

/** DOC-01 (sem filtros: a filtragem é sobre a lista carregada — RN-DOC-20). */
export async function fetchProcessDocuments(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessDocumentsList> {
  const result = await apiRequest<ProcessDocumentDto[]>(`/processes/${processId}/documents`, {
    signal,
  });
  const meta = result.meta as Partial<ProcessDocumentsMeta>;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    meta: {
      currentStage: meta.currentStage ?? EMPTY_META.currentStage,
      creatableTypeIds: meta.creatableTypeIds ?? EMPTY_META.creatableTypeIds,
      pendingTypeIds: meta.pendingTypeIds ?? EMPTY_META.pendingTypeIds,
    },
  };
}

/** DTY-01: tipos ativos do tenant (nomes, `kind` e `sortOrder` dos cartões e do menu). */
export async function fetchActiveDocumentTypes(signal?: AbortSignal): Promise<DocumentTypeDto[]> {
  const result = await apiRequest<DocumentTypeDto[]>('/document-types', { signal });
  return Array.isArray(result.data) ? result.data : [];
}

export function useProcessDocuments(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processDocumentKeys.list(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessDocuments(processId, signal),
    // Concorrência: ao voltar à janela, revalida mesmo dentro do `staleTime` padrão (30 s).
    refetchOnWindowFocus: 'always',
    throwOnError: false,
  });
}

export function useActiveDocumentTypes() {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: processDocumentKeys.activeTypes(tenantId),
    queryFn: ({ signal }) => fetchActiveDocumentTypes(signal),
    staleTime: ACTIVE_TYPES_STALE_TIME_MS,
    throwOnError: false,
  });
}
