import type {
  ProcessColumnKey,
  SavedViewDto,
  SavedViewFilters,
  SavedViewScope,
} from '@contrataflow/validation';

import { apiDownload, apiRequest, newCorrelationId, retryIdempotent } from '@/lib/api/client';
import type { ApiDownload } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Visões salvas e exportação CSV da lista de processos (US-003 · PRC-34..38). Chaves
 * `['t', tenantId, 'saved-views', scope]` (RN-FND-90). A criação usa `Idempotency-Key` (a mesma
 * chave em cada reenvio por falha transitória); alterar e excluir usam `If-Match` com a versão lida.
 */

export const SAVED_VIEW_SCOPE: SavedViewScope = 'PROCESS_LIST';

export const savedViewKeys = {
  list: (tenantId: string, scope: SavedViewScope = SAVED_VIEW_SCOPE) =>
    tenantKey(tenantId, 'saved-views', scope),
};

/** As visões mudam pouco e só por ações do próprio usuário (ou colegas, para as compartilhadas). */
export const SAVED_VIEWS_STALE_TIME_MS = 60_000;

const ifMatch = (version: number) => `"${String(version)}"`;

/** PRC-35: minhas visões e as compartilhadas por colegas (`isOwner` distingue). */
export async function fetchSavedViews(
  scope: SavedViewScope = SAVED_VIEW_SCOPE,
  signal?: AbortSignal,
): Promise<SavedViewDto[]> {
  const result = await apiRequest<SavedViewDto[]>('/saved-views', { query: { scope }, signal });
  return Array.isArray(result.data) ? result.data : [];
}

export interface NewSavedView {
  readonly scope: SavedViewScope;
  readonly name: string;
  readonly filters: SavedViewFilters;
  readonly sort: string | null;
  readonly columns: readonly ProcessColumnKey[];
  readonly isShared: boolean;
  readonly isDefault: boolean;
}

/** PRC-36: reenvia com a mesma `Idempotency-Key` em falha transitória. */
export async function createSavedView(
  body: NewSavedView,
  idempotencyKey: string,
): Promise<SavedViewDto> {
  const correlationId = newCorrelationId();
  return (
    await retryIdempotent(() =>
      apiRequest<SavedViewDto>('/saved-views', {
        method: 'POST',
        body,
        idempotencyKey,
        correlationId,
      }),
    )
  ).data;
}

export interface SavedViewPatch {
  readonly name?: string;
  readonly filters?: SavedViewFilters;
  readonly sort?: string | null;
  readonly columns?: readonly ProcessColumnKey[];
  readonly isShared?: boolean;
  readonly isDefault?: boolean;
}

/** PRC-37 com a versão da visão em `If-Match`. */
export async function updateSavedView(
  id: string,
  patch: SavedViewPatch,
  version: number,
): Promise<SavedViewDto> {
  return (
    await apiRequest<SavedViewDto>(`/saved-views/${id}`, {
      method: 'PATCH',
      body: patch,
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** PRC-38 com a versão da visão em `If-Match`. */
export async function deleteSavedView(id: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/saved-views/${id}`, { method: 'DELETE', ifMatch: ifMatch(version) });
}

/** PRC-34: o CSV da consulta (stream no servidor; aqui vira `Blob`). `signal` cancela o fetch. */
export function downloadProcessesCsv(
  query: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ApiDownload> {
  return apiDownload('/processes/export', {
    query,
    signal,
    correlationId: newCorrelationId(),
  });
}
