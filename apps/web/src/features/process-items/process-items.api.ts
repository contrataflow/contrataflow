import type {
  CreateProcessItemInput,
  ProcessItemDto,
  UpdateProcessItemInput,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Itens da contratação (US-006 · SCR-006 aba "Itens"): PRC-13..17 de api/02-processes.md. Chave
 * `['t', tenantId, 'processes', id, 'items']` (sob a do processo: a invalidação do painel a
 * alcança). O `ETag` do PRC-13 é a versão do PROCESSO, usada como `If-Match` do PRC-17; PATCH e
 * DELETE usam a versão do item (`version` do DTO).
 */

export const itemKeys = {
  list: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'items'),
};

export interface ProcessItemList {
  readonly items: readonly ProcessItemDto[];
  /** Versão do processo (`ETag` do PRC-13). */
  readonly processVersion: number;
}

function versionOf(etag: string | null): number {
  const parsed = Number((etag ?? '').replaceAll('"', '').replace(/^W\//, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

const ifMatch = (version: number) => `"${String(version)}"`;

/** PRC-13. */
export async function fetchProcessItems(
  processId: string,
  signal?: AbortSignal,
): Promise<ProcessItemList> {
  const result = await apiRequest<ProcessItemDto[]>(`/processes/${processId}/items`, { signal });
  return {
    items: Array.isArray(result.data) ? result.data : [],
    processVersion: versionOf(result.meta.etag),
  };
}

export function useProcessItems(processId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: itemKeys.list(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessItems(processId, signal),
    refetchOnWindowFocus: true,
    throwOnError: false,
  });
}

/** PRC-14 (a mesma `Idempotency-Key` em cada reenvio do mesmo formulário). */
export async function createProcessItem(
  processId: string,
  body: CreateProcessItemInput,
  idempotencyKey: string,
): Promise<ProcessItemDto> {
  return (
    await apiRequest<ProcessItemDto>(`/processes/${processId}/items`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

/** PRC-15 com a versão do item. */
export async function updateProcessItem(
  itemId: string,
  body: UpdateProcessItemInput,
  version: number,
): Promise<ProcessItemDto> {
  return (
    await apiRequest<ProcessItemDto>(`/process-items/${itemId}`, {
      method: 'PATCH',
      body,
      ifMatch: ifMatch(version),
    })
  ).data;
}

/** PRC-16 com a versão do item. */
export async function deleteProcessItem(itemId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/process-items/${itemId}`, {
    method: 'DELETE',
    ifMatch: ifMatch(version),
  });
}

/** PRC-17 com a versão do processo (o `ETag` do PRC-13). */
export async function reorderProcessItems(
  processId: string,
  itemIds: readonly string[],
  processVersion: number,
): Promise<ProcessItemList> {
  const result = await apiRequest<ProcessItemDto[]>(`/processes/${processId}/items/reorder`, {
    method: 'POST',
    body: { itemIds },
    ifMatch: ifMatch(processVersion),
  });
  return { items: result.data, processVersion: versionOf(result.meta.etag) };
}
