import { PRICE_SUMMARY_COLLECTIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  buildComparativeMap,
  comparativeMapFor,
  comparativeMapSnapshot,
  maskComparativeMap,
} from './comparative-map.js';
import type { ComparativeMapInput } from './comparative-map.js';
import { parametersSnapshot } from './price-research.js';
import type { PriceItem, PriceResearch } from './price-research.js';
import type { PriceSource, Quotation } from './price-source.js';

/*
 * US-031 — `ComparativeMapBuilder` puro (RN-PRICE-53/56): matriz completa, item sem fonte, fonte
 * sem cotação, ordenação por `sortOrder`, o mascaramento POL-09 e o snapshot do PDF (a máscara do
 * `document` sobre essas coleções: `document/domain/price-summary-html.spec.ts`).
 */

const NOW = new Date('2026-10-06T12:00:00.000Z');
const PARAMETERS = parametersSnapshot(
  new Map<string, unknown>([
    ['priceResearch.defaultMethod', 'AUTO_CV'],
    ['priceResearch.cvThresholdPercent', 25],
    ['priceResearch.minQuotations', 3],
    ['priceResearch.directQuoteMaxAgeDays', 180],
    ['priceResearch.similarContractMaxAgeDays', 365],
    ['priceResearch.outlierLowerPercent', 70],
    ['priceResearch.outlierUpperPercent', 130],
    ['priceResearch.unitPriceDecimals', 2],
    ['priceResearch.roundingMode', 'HALF_UP'],
  ]),
);

/** Preços e estatísticas do cenário (a quantidade `10.0000` não é valor monetário). */
const PRICES =
  /"(100\.0000|200\.0000|50\.0000|60\.0000|150\.0000|70\.7107|47\.1405|150\.00|1500\.00)"/;

const id = (n: number) => `0192d031-0000-7000-8000-${String(n).padStart(12, '0')}`;

const RESEARCH: PriceResearch = {
  id: id(1),
  tenantId: 't',
  processId: id(2),
  documentId: id(1),
  referenceDate: '2026-10-06',
  parameters: PARAMETERS,
  totalEstimatedValue: '1500.00',
  itemsCount: 3,
  itemsWithAlertsCount: 1,
  lastCalculatedAt: NOW,
  completedAt: null,
  completedById: null,
  createdAt: NOW,
  updatedAt: NOW,
  createdById: null,
  updatedById: null,
  version: 4,
};

function item(n: number, sortOrder: number, overrides: Partial<PriceItem> = {}): PriceItem {
  return {
    id: id(100 + n),
    tenantId: 't',
    priceResearchId: RESEARCH.id,
    processItemId: id(200 + n),
    quantity: '10.0000',
    methodOverride: null,
    effectiveMethod: 'MEAN',
    validQuotationsCount: 2,
    meanPrice: '150.0000',
    medianPrice: '150.0000',
    lowestPrice: '100.0000',
    highestPrice: '200.0000',
    stdDeviation: '70.7107',
    coefficientOfVariation: '47.1405',
    recommendedUnitPrice: '150.00',
    manualUnitPrice: null,
    manualJustification: null,
    totalPrice: '1500.00',
    belowMinimumJustification: null,
    alerts: [{ code: 'HIGH_CV' }],
    notes: null,
    sortOrder,
    calculatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

function source(n: number, sortOrder: number, supplierId: string | null = null): PriceSource {
  return {
    id: id(300 + n),
    tenantId: 't',
    priceResearchId: RESEARCH.id,
    processId: RESEARCH.processId,
    sourceTypeId: id(400),
    supplierId,
    description: `Fonte ${String(n)}`,
    quoteDate: '2026-09-30',
    accessedAt: null,
    url: null,
    referenceOrganization: null,
    referenceDocument: null,
    supplierChoiceJustification: null,
    notes: null,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
  };
}

function quotation(
  itemNumber: number,
  sourceNumber: number,
  unitPrice: string,
  overrides: Partial<Quotation> = {},
): Quotation {
  return {
    id: id(500 + itemNumber * 10 + sourceNumber),
    tenantId: 't',
    priceResearchId: RESEARCH.id,
    priceItemId: id(100 + itemNumber),
    priceSourceId: id(300 + sourceNumber),
    unitPrice,
    brandModel: null,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    excludedById: null,
    excludedAt: null,
    outlierFlag: 'NONE',
    isExpired: false,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

function input(overrides: Partial<ComparativeMapInput> = {}): ComparativeMapInput {
  return {
    research: RESEARCH,
    code: 'PP 0001/2026',
    title: 'Pesquisa de preços — 0012/2026',
    // Fora de ordem de propósito: o mapa ordena por `sortOrder`.
    items: [item(2, 2), item(1, 1), item(3, 3, { validQuotationsCount: 0, alerts: [] })],
    sources: [source(2, 2), source(1, 1, id(600))],
    quotations: [
      quotation(1, 2, '200.0000', { outlierFlag: 'HIGH' }),
      quotation(1, 1, '100.0000'),
      quotation(2, 1, '50.0000', { status: 'EXCLUDED', exclusionReason: 'INCONSISTENT' }),
      quotation(2, 2, '60.0000', { isExpired: true }),
    ],
    itemRefs: new Map([
      [id(201), { sequence: 1, lotNumber: null, description: 'Cimento', unitLabel: 'SC' }],
      [id(202), { sequence: 2, lotNumber: 1, description: 'Areia', unitLabel: 'M3' }],
      [id(203), { sequence: 3, lotNumber: null, description: 'Brita', unitLabel: 'M3' }],
    ]),
    sourceTypes: new Map([
      [id(400), { code: 'PESQUISA_DIRETA_FORNECEDOR', label: 'Pesquisa direta' }],
    ]),
    supplierNames: new Map([[id(600), 'Construtora XYZ Ltda']]),
    ...overrides,
  };
}

describe('buildComparativeMap (RN-PRICE-53)', () => {
  it('matriz completa: itens e fontes por sortOrder, células por item e fonte, estatísticas e alertas', () => {
    const map = buildComparativeMap(input());
    expect(map.items.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(map.sources.map((column) => column.description)).toEqual(['Fonte 1', 'Fonte 2']);
    expect(map.cells.map((cell) => [cell.priceItemId, cell.priceSourceId])).toEqual([
      [id(101), id(301)],
      [id(101), id(302)],
      [id(102), id(301)],
      [id(102), id(302)],
    ]);
    expect(map.cells[1]).toEqual({
      priceItemId: id(101),
      priceSourceId: id(302),
      quotationId: id(512),
      unitPrice: '200.0000',
      unitPriceMasked: false,
      status: 'VALID',
      exclusionReason: null,
      outlierFlag: 'HIGH',
      isExpired: false,
    });
    expect(map.cells[2]).toMatchObject({ status: 'EXCLUDED', exclusionReason: 'INCONSISTENT' });
    expect(map.cells[3]).toMatchObject({ isExpired: true });
    expect(map.items[0]).toMatchObject({
      description: 'Cimento',
      unitLabel: 'SC',
      meanPrice: '150.0000',
      recommendedUnitPrice: '150.00',
      valuesMasked: false,
      alerts: [{ code: 'HIGH_CV' }],
    });
    expect(map.items[1]).toMatchObject({ lotNumber: 1 });
    expect(map.sources[0]).toMatchObject({
      sourceType: { code: 'PESQUISA_DIRETA_FORNECEDOR', label: 'Pesquisa direta' },
      supplierName: 'Construtora XYZ Ltda',
    });
    expect(map.sources[1]?.supplierName).toBeNull();
    expect(map).toMatchObject({
      priceResearchId: RESEARCH.id,
      code: 'PP 0001/2026',
      referenceDate: '2026-10-06',
      lastCalculatedAt: NOW.toISOString(),
      unitPriceDecimals: 2,
      totalEstimatedValue: '1500.00',
      masked: false,
    });
  });

  it('item sem cotação em fonte nenhuma fica na linha, sem células', () => {
    const map = buildComparativeMap(input());
    expect(map.items.at(-1)?.sequence).toBe(3);
    expect(map.cells.some((cell) => cell.priceItemId === id(103))).toBe(false);
  });

  it('fonte sem cotação continua como coluna (cruzamentos vazios)', () => {
    const map = buildComparativeMap(input({ sources: [source(1, 1), source(2, 2), source(3, 3)] }));
    expect(map.sources).toHaveLength(3);
    expect(map.cells.some((cell) => cell.priceSourceId === id(303))).toBe(false);
  });

  it('sem fontes (FA-04): itens em linha e nenhuma célula', () => {
    const map = buildComparativeMap(input({ sources: [], quotations: [] }));
    expect(map.items).toHaveLength(3);
    expect(map.sources).toEqual([]);
    expect(map.cells).toEqual([]);
  });

  it('cotação de item/fonte que não estão no retrato fica de fora', () => {
    const map = buildComparativeMap(
      input({ quotations: [quotation(9, 1, '10.0000'), quotation(1, 9, '10.0000')] }),
    );
    expect(map.cells).toEqual([]);
  });

  it('item sem referência do processo (removido) usa o sortOrder e textos vazios', () => {
    const map = buildComparativeMap(input({ itemRefs: new Map() }));
    expect(map.items[0]).toMatchObject({ sequence: 1, description: '', unitLabel: '' });
  });
});

describe('maskComparativeMap (POL-09 · RN-PRICE-56)', () => {
  it('toda célula, estatística e total null com a marca; selos e alertas continuam', () => {
    const masked = maskComparativeMap(buildComparativeMap(input()));
    expect(masked.masked).toBe(true);
    expect(masked.totalEstimatedValue).toBeNull();
    for (const cell of masked.cells) {
      expect(cell).toMatchObject({ unitPrice: null, unitPriceMasked: true });
    }
    expect(masked.cells[1]?.outlierFlag).toBe('HIGH');
    for (const row of masked.items) {
      expect(row).toMatchObject({
        meanPrice: null,
        medianPrice: null,
        lowestPrice: null,
        highestPrice: null,
        stdDeviation: null,
        coefficientOfVariation: null,
        recommendedUnitPrice: null,
        totalPrice: null,
        valuesMasked: true,
      });
    }
    expect(masked.items[0]?.alerts).toEqual([{ code: 'HIGH_CV' }]);
    expect(JSON.stringify(masked)).not.toMatch(PRICES);
  });

  it('comparativeMapFor só mascara quando pedido', () => {
    const map = buildComparativeMap(input());
    expect(comparativeMapFor(map, false)).toBe(map);
    expect(comparativeMapFor(map, true).masked).toBe(true);
  });
});

describe('comparativeMapSnapshot (seção PRICE_SUMMARY · RN-PRICE-55)', () => {
  it('células alinhadas às colunas (null = sem cotação) e o resumo', () => {
    const collections = comparativeMapSnapshot(buildComparativeMap(input()));
    const [summary] = collections[PRICE_SUMMARY_COLLECTIONS.summary] ?? [];
    expect(summary).toEqual({
      referenceDate: '2026-10-06',
      lastCalculatedAt: NOW.toISOString(),
      unitPriceDecimals: 2,
      totalEstimatedValue: '1500.00',
    });
    expect(collections[PRICE_SUMMARY_COLLECTIONS.sources]).toHaveLength(2);
    const rows = collections[PRICE_SUMMARY_COLLECTIONS.items] as { cells: unknown[] }[];
    expect(rows[0]?.cells).toEqual([
      { unitPrice: '100.0000', status: 'VALID', outlierFlag: 'NONE', isExpired: false },
      { unitPrice: '200.0000', status: 'VALID', outlierFlag: 'HIGH', isExpired: false },
    ]);
    expect(rows[2]?.cells).toEqual([null, null]);
  });
});
