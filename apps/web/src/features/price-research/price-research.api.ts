import type {
  AddPriceItems,
  CreatePriceResearch,
  PriceItemDto,
  PriceResearchDto,
  PriceResearchMeta,
  PriceResearchSummaryDto,
  UpdatePriceResearch,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '@/lib/api/api-error';
import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

/*
 * Pesquisa de preços (US-024 · SCR-009): PRS-01..08 de api/07-price-research.md. O id da pesquisa é
 * o do documento. Chaves `['t', tenantId, 'price-research', id]` (cabeçalho) e
 * `['t', tenantId, 'price-research', id, 'items']` (sob a do cabeçalho: invalidar a pesquisa renova
 * os itens) e `['t', tenantId, 'processes', processId, 'price-research']` (PRS-01, sob a do processo).
 * O `ETag` do PRS-03/04 é a `version` da pesquisa; o `If-Match` do PRS-08 é a `version` do item.
 */

export const priceResearchKeys = {
  detail: (tenantId: string, researchId: string) =>
    tenantKey(tenantId, 'price-research', researchId),
  items: (tenantId: string, researchId: string) =>
    tenantKey(tenantId, 'price-research', researchId, 'items'),
  ofProcess: (tenantId: string, processId: string) =>
    tenantKey(tenantId, 'processes', processId, 'price-research'),
};

/** Pesquisa e o `meta` (ações, motivo do bloqueio e a versão de template fixada). */
export interface PriceResearchResult {
  readonly research: PriceResearchDto;
  readonly meta: PriceResearchMeta;
  /** `version` da pesquisa (o `If-Match` do PRS-04). */
  readonly version: number;
}

function versionOf(etag: string | null): number {
  const parsed = Number((etag ?? '').replaceAll('"', '').replace(/^W\//, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

function toResult(result: ApiResult<PriceResearchDto>): PriceResearchResult {
  const meta = result.meta as Partial<PriceResearchMeta>;
  return {
    research: result.data,
    meta: {
      allowedActions: meta.allowedActions ?? [],
      documentActions: meta.documentActions ?? [],
      lockReason: meta.lockReason ?? null,
      template: meta.template ?? null,
    },
    version:
      typeof result.data.version === 'number' ? result.data.version : versionOf(result.meta.etag),
  };
}

const ifMatchOf = (version: number) => `"${String(version)}"`;

/** Rota da SCR-009. */
export function priceResearchHref(processId: string, researchId: string): string {
  return `/processos/${processId}/pesquisa-precos/${researchId}`;
}

/** Aba "Itens" do painel do processo (SCR-006 · `?aba=itens`). */
export function processItemsHref(processId: string): string {
  return `/processos/${processId}?aba=itens`;
}

/** PRS-01: 0 ou 1 pesquisa não cancelada + as canceladas. */
export async function fetchProcessPriceResearch(
  processId: string,
  signal?: AbortSignal,
): Promise<PriceResearchSummaryDto[]> {
  const result = await apiRequest<PriceResearchSummaryDto[]>(
    `/processes/${processId}/price-research`,
    { signal },
  );
  return Array.isArray(result.data) ? result.data : [];
}

/** A pesquisa não cancelada do processo (FA-01), se houver. */
export function activeResearchOf(
  summaries: readonly PriceResearchSummaryDto[] | undefined,
): PriceResearchSummaryDto | null {
  return summaries?.find((summary) => summary.status !== 'CANCELED') ?? null;
}

export function useProcessPriceResearch(processId: string, enabled = true) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: priceResearchKeys.ofProcess(tenantId, processId),
    queryFn: ({ signal }) => fetchProcessPriceResearch(processId, signal),
    enabled,
    throwOnError: false,
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * PRS-02 (a mesma `Idempotency-Key` em cada reenvio da mesma solicitação). `IDEMPOTENCY_IN_PROGRESS`
 * (a mesma solicitação ainda em processamento) repete a chamada após 2 s, até 3 vezes.
 */
export async function createPriceResearch(
  processId: string,
  body: CreatePriceResearch,
  idempotencyKey: string,
): Promise<PriceResearchResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return toResult(
        await apiRequest<PriceResearchDto>(`/processes/${processId}/price-research`, {
          method: 'POST',
          body,
          idempotencyKey,
        }),
      );
    } catch (error) {
      if (attempt >= 3 || !isApiError(error) || error.code !== 'IDEMPOTENCY_IN_PROGRESS') {
        throw error;
      }
      await sleep((error.retryAfterSeconds ?? 2) * 1000);
    }
  }
}

/** PRS-03. */
export async function fetchPriceResearch(
  researchId: string,
  signal?: AbortSignal,
): Promise<PriceResearchResult> {
  return toResult(await apiRequest<PriceResearchDto>(`/price-research/${researchId}`, { signal }));
}

export function usePriceResearch(researchId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: priceResearchKeys.detail(tenantId, researchId),
    queryFn: ({ signal }) => fetchPriceResearch(researchId, signal),
    refetchOnWindowFocus: true,
    throwOnError: false,
  });
}

/** PRS-04 com a versão da pesquisa. */
export async function updatePriceResearch(
  researchId: string,
  body: UpdatePriceResearch,
  version: number,
): Promise<PriceResearchResult> {
  return toResult(
    await apiRequest<PriceResearchDto>(`/price-research/${researchId}`, {
      method: 'PATCH',
      body,
      ifMatch: ifMatchOf(version),
    }),
  );
}

const ITEMS_PAGE_SIZE = 100;

/** PRS-05 (todas as páginas; a SCR-009 mostra a lista inteira, em ordem de `sortOrder`). */
export async function fetchPriceItems(
  researchId: string,
  signal?: AbortSignal,
): Promise<PriceItemDto[]> {
  const items: PriceItemDto[] = [];
  for (let page = 1; ; page += 1) {
    const result = await apiRequest<PriceItemDto[]>(`/price-research/${researchId}/items`, {
      query: { page, pageSize: ITEMS_PAGE_SIZE },
      signal,
    });
    const data = Array.isArray(result.data) ? result.data : [];
    items.push(...data);
    const totalPages = typeof result.meta.totalPages === 'number' ? result.meta.totalPages : 1;
    if (page >= totalPages || data.length === 0) return items;
  }
}

export function usePriceItems(researchId: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: priceResearchKeys.items(tenantId, researchId),
    queryFn: ({ signal }) => fetchPriceItems(researchId, signal),
    throwOnError: false,
  });
}

/** PRS-06: inclui itens do processo ainda ausentes da pesquisa. */
export async function addPriceItems(
  researchId: string,
  body: AddPriceItems,
): Promise<PriceItemDto[]> {
  const result = await apiRequest<PriceItemDto[]>(`/price-research/${researchId}/items`, {
    method: 'POST',
    body,
  });
  return Array.isArray(result.data) ? result.data : [];
}

/** PRS-08 com a versão do item. */
export async function deletePriceItem(itemId: string, version: number): Promise<void> {
  await apiRequest<unknown>(`/price-items/${itemId}`, {
    method: 'DELETE',
    ifMatch: ifMatchOf(version),
  });
}
