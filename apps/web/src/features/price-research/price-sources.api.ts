import type {
  CreatePriceSource,
  PriceSourceDto,
  QuotationDto,
  QuotationLine,
  UpdatePriceSource,
  UpdateQuotation,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Fontes de pesquisa e cotações (US-026 · SCR-009, aba "Fontes"): PRS-09..15 de
 * api/07-price-research-suppliers.md. Chave `['t', tenantId, 'price-research', id, 'sources']` (sob a
 * do cabeçalho: invalidar a pesquisa renova as fontes). O `If-Match` do PRS-11/12/13 é a `version` da
 * fonte; o do PRS-14/15, a `version` da cotação. A grade (PRS-13) leva `Idempotency-Key` — o mesmo
 * valor em cada reenvio do mesmo "Salvar preços" (FA-07).
 */

export const priceSourceKeys = {
  list: (tenantId: string, researchId: string) =>
    tenantKey(tenantId, 'price-research', researchId, 'sources'),
};

const ifMatchOf = (version: number) => `"${String(version)}"`;
const PAGE_SIZE = 100;

/** PRS-09 (todas as páginas, na ordem de registro). */
export async function fetchPriceSources(
  researchId: string,
  signal?: AbortSignal,
): Promise<PriceSourceDto[]> {
  const sources: PriceSourceDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await apiRequest<PriceSourceDto[]>(`/price-research/${researchId}/sources`, {
      query: { page, pageSize: PAGE_SIZE },
      signal,
    });
    const data = Array.isArray(result.data) ? result.data : [];
    sources.push(...data);
    const totalPages = typeof result.meta.totalPages === 'number' ? result.meta.totalPages : 1;
    if (page >= totalPages || data.length === 0) return sources;
  }
}

export function usePriceSources(researchId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: priceSourceKeys.list(tenantId, researchId),
    queryFn: ({ signal }) => fetchPriceSources(researchId, signal),
    throwOnError: false,
  });
}

/** PRS-10 (`Idempotency-Key` da ação de salvar). */
export async function createPriceSource(
  researchId: string,
  body: CreatePriceSource,
  idempotencyKey: string,
): Promise<PriceSourceDto> {
  const result = await apiRequest<PriceSourceDto>(`/price-research/${researchId}/sources`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
  return result.data;
}

/** PRS-11 com a versão da fonte. */
export async function updatePriceSource(
  sourceId: string,
  body: UpdatePriceSource,
  version: number,
): Promise<PriceSourceDto> {
  const result = await apiRequest<PriceSourceDto>(`/price-sources/${sourceId}`, {
    method: 'PATCH',
    body,
    ifMatch: ifMatchOf(version),
  });
  return result.data;
}

/** PRS-12 com a versão da fonte (as cotações vão em cascata). */
export async function deletePriceSource(sourceId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/price-sources/${sourceId}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(version),
  });
}

/** PRS-13: a grade da fonte (linhas preenchidas), com a versão da fonte. */
export async function saveQuotationGrid(
  sourceId: string,
  items: readonly QuotationLine[],
  version: number,
  idempotencyKey: string,
): Promise<QuotationDto[]> {
  const result = await apiRequest<QuotationDto[]>(`/price-sources/${sourceId}/quotations`, {
    method: 'PUT',
    body: { items },
    ifMatch: ifMatchOf(version),
    idempotencyKey,
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** PRS-14 com a versão da cotação. */
export async function updateQuotation(
  quotationId: string,
  body: UpdateQuotation,
  version: number,
): Promise<QuotationDto> {
  const result = await apiRequest<QuotationDto>(`/quotations/${quotationId}`, {
    method: 'PATCH',
    body,
    ifMatch: ifMatchOf(version),
  });
  return result.data;
}

/** PRS-15 com a versão da cotação. */
export async function deleteQuotation(quotationId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/quotations/${quotationId}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(version),
  });
}
