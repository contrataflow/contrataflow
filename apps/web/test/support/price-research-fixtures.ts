// Dados e API simulada da pesquisa de preços (US-024 · SCR-009 e diálogo de criação; US-026 · aba
// "Fontes").
import type {
  PriceItemDto,
  PriceResearchDto,
  PriceResearchMeta,
  PriceSourceDto,
  ProcessItemDto,
  QuotationDto,
} from '@contrataflow/validation';
import { vi } from 'vitest';

import { ID, PROCESS_ID, UNIDADE, catalogItem } from './process-fixtures';
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
    alerts: [{ code: 'NO_VALID_QUOTES' }],
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

// --- US-026: fontes e cotações -------------------------------------------------------------------

export const SOURCE_ID = ID(730);
export const SUPPLIER_ID = ID(740);

/** Tipos de fonte do catálogo `PRICE_SOURCE_TYPE` (metadata como a semeada). */
export const DIRETA = catalogItem(
  720,
  'PRICE_SOURCE_TYPE',
  'PESQUISA_DIRETA_FORNECEDOR',
  'Pesquisa direta com fornecedor',
  {
    metadata: {
      legalBasis: 'Lei 14.133/2021, art. 23, § 1º, IV',
      requiredFields: ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'],
      maxAgeDays: 180,
      ageReference: 'quoteDate',
    },
  },
);
export const SITIO = catalogItem(
  721,
  'PRICE_SOURCE_TYPE',
  'SITIO_ELETRONICO',
  'Sítio eletrônico especializado',
  {
    metadata: {
      legalBasis: 'Lei 14.133/2021, art. 23, § 1º, III',
      requiredFields: ['url', 'accessedAt'],
    },
  },
);

/** Cotação do item nº `n` da pesquisa na fonte padrão. */
export function quotationDto(n: number, extra: Partial<QuotationDto> = {}): QuotationDto {
  return {
    id: ID(800 + n),
    priceResearchId: RESEARCH_ID,
    priceItemId: ID(950 + n),
    priceSourceId: SOURCE_ID,
    unitPrice: '150.0000',
    unitPriceMasked: false,
    brandModel: null,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    outlierFlag: 'NONE',
    isExpired: false,
    createdAt: '2026-10-16T13:00:00.000Z',
    updatedAt: '2026-10-16T13:00:00.000Z',
    version: 1,
    ...extra,
  };
}

export function priceSourceDto(extra: Partial<PriceSourceDto> = {}): PriceSourceDto {
  return {
    id: SOURCE_ID,
    priceResearchId: RESEARCH_ID,
    sourceTypeId: DIRETA.id,
    sourceType: {
      id: DIRETA.id,
      code: DIRETA.code,
      label: DIRETA.label,
      isActive: true,
      requiredFields: ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'],
      maxAgeDays: 180,
    },
    description: 'Orçamento Construtora XYZ',
    supplierId: SUPPLIER_ID,
    supplier: {
      id: SUPPLIER_ID,
      legalName: 'Construtora XYZ Ltda.',
      documentNumber: '11.222.333/0001-81',
    },
    quoteDate: '2026-09-30',
    accessedAt: null,
    url: null,
    referenceOrganization: null,
    referenceDocument: null,
    supplierChoiceJustification: 'Fornecedor do ramo com atuação na região.',
    notes: null,
    sortOrder: 0,
    quotations: [],
    createdAt: '2026-10-16T13:00:00.000Z',
    updatedAt: '2026-10-16T13:00:00.000Z',
    version: 1,
    ...extra,
  };
}

/** PRS-09 com as fontes dadas. */
export function sourcesRoute(
  sources: readonly PriceSourceDto[] | (() => readonly PriceSourceDto[]),
): Route {
  return (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') return undefined;
    if (!url.startsWith(`/api/v1/price-research/${RESEARCH_ID}/sources`)) return undefined;
    const list = typeof sources === 'function' ? sources() : sources;
    return jsonResponse({
      data: list,
      meta: { page: 1, pageSize: 100, totalItems: list.length, totalPages: 1 },
    });
  };
}
