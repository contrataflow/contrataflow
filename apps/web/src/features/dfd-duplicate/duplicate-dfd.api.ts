import type { DfdDto, DfdDuplicate, ProcessListItemDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';

import { fetchProcessList } from '../process-list/process-list.api';

/*
 * Duplicação do DFD (US-018 · SCR-113): DFD-05 de api/05-dfd.md — `POST` com o destino escolhido e
 * a `Idempotency-Key` gerada ao abrir o diálogo (a mesma vale para cada reenvio). A busca do
 * "processo existente" reaproveita o PRC-01 (US-002).
 */

/** DFD-05: devolve o novo DFD (`documentId` = id; `processId` = o processo destino). */
export async function duplicateDfd(
  dfdId: string,
  body: DfdDuplicate,
  idempotencyKey: string,
): Promise<DfdDto> {
  return (
    await apiRequest<DfdDto>(`/dfds/${dfdId}/duplicate`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  ).data;
}

/** Quantos processos a busca do destino traz por vez. */
export const TARGET_SEARCH_PAGE_SIZE = 10;

/** PRC-01 restrito aos status que aceitam DFD novo (RN-DFD-73); o resto a API confere ao confirmar. */
export async function searchTargetProcesses(
  text: string,
  signal?: AbortSignal,
): Promise<ProcessListItemDto[]> {
  const page = await fetchProcessList(
    {
      q: text,
      status: 'DRAFT,IN_PROGRESS,RETURNED',
      sort: '-updatedAt',
      pageSize: String(TARGET_SEARCH_PAGE_SIZE),
    },
    signal,
  );
  return page.items;
}
