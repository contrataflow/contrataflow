// US-031 · "Testes necessários" (k6 com exportações de 500 × 50 → p95 < 2 s): a parte da exportação
// síncrona do PRS-22 que cresce com o teto — montar a matriz (`buildComparativeMap`), aplicar a POL-09
// e gerar o `.xlsx` (`comparativeMapSheet` + `writeXlsx`) — para 500 itens × 50 fontes com todas as
// células cotadas, bem abaixo dos 2 s do p95 (sobra para a leitura no banco e a auditoria). Mede o
// motor puro (sem banco nem HTTP). Suíte de performance (DEC-087: medida no endurecimento, fora do CI
// do PR): `pnpm --filter @contrataflow/api test:perf`.
import { COMPARATIVE_MAP_LIMITS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { writeXlsx } from '#shared/spreadsheet/xlsx.js';

import { comparativeMapSheet } from '../../src/modules/price-research/application/comparative-map.xlsx.js';
import {
  buildComparativeMap,
  maskComparativeMap,
} from '../../src/modules/price-research/domain/comparative-map.js';
import type {
  PriceItem,
  PriceResearch,
} from '../../src/modules/price-research/domain/price-research.js';
import type {
  PriceSource,
  Quotation,
} from '../../src/modules/price-research/domain/price-source.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ITEMS = COMPARATIVE_MAP_LIMITS.maxExportItems;
const SOURCES = COMPARATIVE_MAP_LIMITS.maxExportSources;
const WARMUP = 3;
const SAMPLES = 20;
/** Fatia do p95 de 2 s reservada à montagem e à escrita do arquivo. */
const P95_BUDGET_MS = 1000;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

const research = {
  id: 'r',
  tenantId: 't',
  processId: 'p',
  documentId: 'r',
  referenceDate: '2026-10-06',
  parameters: { unitPriceDecimals: 2 },
  totalEstimatedValue: '123456789.00',
  itemsCount: ITEMS,
  itemsWithAlertsCount: ITEMS,
  lastCalculatedAt: NOW,
} as unknown as PriceResearch;

const items = Array.from(
  { length: ITEMS },
  (_, index) =>
    ({
      id: `item-${String(index)}`,
      processItemId: `pi-${String(index)}`,
      quantity: '10.0000',
      effectiveMethod: 'MEDIAN',
      validQuotationsCount: SOURCES,
      meanPrice: '101.2345',
      medianPrice: '100.0000',
      lowestPrice: '20.0000',
      highestPrice: '200.0000',
      stdDeviation: '12.3456',
      coefficientOfVariation: '12.1951',
      recommendedUnitPrice: '100.00',
      totalPrice: '1000.00',
      alerts: [{ code: 'HAS_OUTLIERS' }],
      sortOrder: index + 1,
    }) as unknown as PriceItem,
);
const sources = Array.from(
  { length: SOURCES },
  (_, index) =>
    ({
      id: `s-${String(index)}`,
      sourceTypeId: 'type',
      supplierId: null,
      description: `Orçamento do fornecedor ${String(index + 1)}`,
      quoteDate: '2026-09-30',
      sortOrder: index + 1,
    }) as unknown as PriceSource,
);
const quotations = items.flatMap((item, row) =>
  sources.map(
    (source, column) =>
      ({
        id: `q-${String(row)}-${String(column)}`,
        priceItemId: item.id,
        priceSourceId: source.id,
        unitPrice: (90 + ((row * 7 + column) % 25)).toFixed(4),
        status: column % 23 === 0 ? 'EXCLUDED' : 'VALID',
        exclusionReason: column % 23 === 0 ? 'INCONSISTENT' : null,
        outlierFlag: column % 17 === 0 ? 'HIGH' : 'NONE',
        isExpired: column % 19 === 0,
      }) as unknown as Quotation,
  ),
);
const itemRefs = new Map(
  items.map((item, index) => [
    item.processItemId,
    {
      sequence: index + 1,
      lotNumber: null,
      description: `Item ${String(index + 1)}`,
      unitLabel: 'UN',
    },
  ]),
);

describe('[Desempenho] exportação XLSX do mapa comparativo no teto de 500 × 50 (US-031)', () => {
  const run = (masked: boolean) => {
    const map = buildComparativeMap({
      research,
      code: 'PP 0001/2026',
      title: 'Pesquisa',
      items,
      sources,
      quotations,
      itemRefs,
      sourceTypes: new Map([['type', { code: 'PESQUISA_DIRETA_FORNECEDOR', label: 'Direta' }]]),
      supplierNames: new Map(),
    });
    return writeXlsx(comparativeMapSheet(masked ? maskComparativeMap(map) : map));
  };

  for (const masked of [false, true]) {
    it(`p95 < ${String(P95_BUDGET_MS)} ms (${String(ITEMS)} itens × ${String(SOURCES)} fontes${masked ? ', mascarado' : ''})`, () => {
      for (let index = 0; index < WARMUP; index += 1) run(masked);
      const samples: number[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        const startedAt = performance.now();
        const file = run(masked);
        samples.push(performance.now() - startedAt);
        expect(file.length).toBeGreaterThan(0);
      }
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });
  }
});
