import type { ComparativeMapDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiDownload, apiRequest } from '@/lib/api/client';
import type { ApiDownload } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import { priceResearchKeys } from './price-research.api';

/*
 * Mapa comparativo (US-031 · SCR-010): PRS-21 (matriz) e PRS-22 (XLSX síncrono) de
 * api/07-price-research.md. Chave `['t', tenantId, 'price-research', id, 'comparative-map']`, sob a
 * da pesquisa: qualquer gravação que invalide a pesquisa (SCR-009) renova o mapa. O mapa nunca é um
 * snapshot (RN-PRICE-57): sem cache longo — volta a buscar ao reabrir a tela.
 */

export const comparativeMapKeys = {
  detail: (tenantId: string, researchId: string) => [
    ...priceResearchKeys.detail(tenantId, researchId),
    'comparative-map',
  ],
};

/** Rota da SCR-010. */
export function comparativeMapHref(processId: string, researchId: string): string {
  return `/processos/${processId}/pesquisa-precos/${researchId}/mapa`;
}

/** PRS-21. */
export async function fetchComparativeMap(
  researchId: string,
  signal?: AbortSignal,
): Promise<ComparativeMapDto> {
  const result = await apiRequest<ComparativeMapDto>(
    `/price-research/${researchId}/comparative-map`,
    { signal },
  );
  return result.data;
}

export function useComparativeMap(researchId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: comparativeMapKeys.detail(tenantId, researchId),
    queryFn: ({ signal }) => fetchComparativeMap(researchId, signal),
    staleTime: 0,
    throwOnError: false,
  });
}

/** PRS-22: o `.xlsx` da matriz (com a POL-09 aplicada pela API). */
export function downloadComparativeMapXlsx(
  researchId: string,
  signal?: AbortSignal,
): Promise<ApiDownload> {
  return apiDownload(`/price-research/${researchId}/comparative-map/export`, {
    query: { format: 'xlsx' },
    signal,
  });
}
