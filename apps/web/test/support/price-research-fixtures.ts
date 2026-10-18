// Dados e API simulada da pesquisa de preços (US-024 · SCR-009 e diálogo de criação).
import type {
  PriceItemDto,
  PriceResearchDto,
  PriceResearchMeta,
  ProcessItemDto,
} from '@contrataflow/validation';
import { vi } from 'vitest';

import { ID, PROCESS_ID, UNIDADE } from './process-fixtures';
import type { ProcessApiMock } from './process-fixtures';
import { jsonResponse, requestUrl } from './render';

export const RESEARCH_ID = ID(701);
export const PRICE_TYPE = ID(710);

export function priceResearchDto(extra: Partial<PriceResearchDto> = {}): PriceResearchDto {
  return {
    id: RESEARCH_ID,
    documentId: RESEARCH_ID,
    processId: PROCESS_ID,
    code: 'PP 0001/2026',
    title: 'Pesquisa de preços — 0012/2026',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    templateVersionId: ID(702),
    documentVersion: 1,
    draftRevision: 0,
    referenceDate: '2026-10-16',
    parameters: {
      defaultMethod: 'AUTO_CV',
      cvThresholdPercent: '25.0000',
      minQuotations: 3,
      directQuoteMaxAgeDays: 180,
      similarContractMaxAgeDays: 365,
      outlierLowerPercent: '70.0000',
      outlierUpperPercent: '130.0000',
      unitPriceDecimals: 2,
      roundingMode: 'HALF_UP',
    },
    itemsCount: 3,
    itemsWithAlertsCount: 3,
    totalEstimatedValue: null,
    totalEstimatedValueMasked: false,
    lastCalculatedAt: null,
    completedAt: null,
    pendingApprovalId: null,
    createdAt: '2026-10-16T13:00:00.000Z',
    updatedAt: '2026-10-16T13:00:00.000Z',
    version: 1,
    ...extra,
  };
}

export function priceResearchMeta(extra: Partial<PriceResearchMeta> = {}): PriceResearchMeta {
  return {
    allowedActions: ['UPDATE', 'ADD_ITEMS', 'REMOVE_ITEMS'],
    documentActions: [],
    lockReason: null,
    template: null,
    ...extra,
  };
}

/** Item do processo (PRC-13) nº `n`, com a quantidade de referência informada (ou ausente). */
export function processItem(
  n: number,
  referenceQuantity: string | null,
  extra: Partial<ProcessItemDto> = {},
): ProcessItemDto {
  return {
    id: ID(900 + n),
    processId: PROCESS_ID,
    sequence: n,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: `Item número ${String(n)}`,
    unitOfMeasure: { id: UNIDADE.id, label: 'Unidade' },
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceMasked: false,
    referenceUnitPriceSourceDocumentId: null,
    references: [],
    version: 1,
    ...extra,
  };
}

/** Item da pesquisa (PRS-05) que espelha o item do processo nº `n`. */
export function priceItem(n: number, extra: Partial<PriceItemDto> = {}): PriceItemDto {
  return {
    id: ID(950 + n),
    priceResearchId: RESEARCH_ID,
    processItemId: ID(900 + n),
    sequence: n,
    lotNumber: null,
    lotName: null,
    description: `Item número ${String(n)}`,
    unit: { id: UNIDADE.id, label: 'Unidade', allowsDecimal: false },
    quantity: '10.0000',
    methodOverride: null,
    effectiveMethod: null,
    validQuotationsCount: 0,
    quotationsCount: 0,
    meanPrice: null,
    medianPrice: null,
    lowestPrice: null,
    highestPrice: null,
    stdDeviation: null,
    coefficientOfVariation: null,
    manualUnitPrice: null,
    manualJustification: null,
    recommendedUnitPrice: null,
    recommendedUnitPriceMasked: false,
    totalPrice: null,
    valuesMasked: false,
    belowMinimumJustification: null,
    alerts: [{ code: 'NO_VALID_QUOTES' }, { code: 'BELOW_MINIMUM_QUOTES' }],
    calculatedAt: null,
    sortOrder: n,
    version: 1,
    ...extra,
  };
}

/** Resposta própria do cenário; `undefined` = passa para a próxima rota. */
export type Route = (url: string, init?: RequestInit) => Response | undefined;

/**
 * `fetch` simulado: as rotas (na ordem) antes da API do processo. Rotas de um cenário vêm antes das
 * padrão, para sobrescrevê-las.
 */
export function stubWithRoutes(api: ProcessApiMock, ...routes: readonly Route[]) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    for (const route of routes) {
      const response = route(url, init);
      if (response !== undefined) return Promise.resolve(response);
    }
    return api(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** PRS-03 e PRS-05 padrão: a pesquisa e os itens dados. */
export function readRoutes(options: {
  readonly research?: PriceResearchDto;
  readonly meta?: PriceResearchMeta;
  readonly items?: readonly PriceItemDto[];
}): Route {
  const research = options.research ?? priceResearchDto();
  const items = options.items ?? [priceItem(1), priceItem(2), priceItem(3)];
  return (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') return undefined;
    if (url === `/api/v1/price-research/${RESEARCH_ID}`) {
      return jsonResponse(
        { data: research, meta: options.meta ?? priceResearchMeta() },
        { headers: { ETag: `"${String(research.version)}"` } },
      );
    }
    if (url.startsWith(`/api/v1/price-research/${RESEARCH_ID}/items`)) {
      return jsonResponse({
        data: items,
        meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
      });
    }
    return undefined;
  };
}
