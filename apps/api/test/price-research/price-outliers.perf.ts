// US-030 · "Testes necessários": o destaque das cotações (RN-PRICE-48 — mediana das DEMAIS, O(n²) por
// item) e a consolidação dos alertas (RN-PRICE-50) para 50 fontes por item em menos de 300 ms (p95),
// o limite do log `price_research.outlier_calc_slow`. Mede o motor puro do recálculo (sem banco): uma
// pesquisa com 20 itens × 50 cotações válidas. Suíte de performance (DEC-087: medida no
// endurecimento, fora do CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { describe, expect, it } from 'vitest';

import {
  createPriceItem,
  createPriceResearch,
  parametersSnapshot,
  recalculate,
} from '../../src/modules/price-research/domain/price-research.js';
import {
  assessQuotations,
  createQuotation,
  quotationFactsByItem,
} from '../../src/modules/price-research/domain/price-source.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ITEMS = 20;
const SOURCES = 50;
const WARMUP = 5;
const SAMPLES = 50;
const P95_BUDGET_MS = 300;

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

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] destaque e alertas com 50 fontes por item (US-030)', () => {
  const items = Array.from({ length: ITEMS }, (_, index) =>
    createPriceItem(
      { processItemId: `pi-${String(index)}`, sequence: index + 1, quantity: '10.0000' },
      {
        id: `item-${String(index)}`,
        tenantId: 't',
        priceResearchId: 'r',
        parameters: PARAMETERS,
        userId: 'u',
        now: NOW,
      },
    ),
  );
  const research = createPriceResearch(
    {
      documentId: 'r',
      tenantId: 't',
      processId: 'p',
      referenceDate: '2026-10-06',
      parameters: PARAMETERS,
      creatorId: 'u',
      now: NOW,
    },
    items,
  );
  const quotations = items.flatMap((item, itemIndex) =>
    Array.from({ length: SOURCES }, (_, source) =>
      createQuotation({
        id: `q-${String(itemIndex)}-${String(source)}`,
        tenantId: 't',
        priceResearchId: 'r',
        priceItemId: item.id,
        priceSourceId: `s-${String(source)}`,
        // Dispersão com alguns destoantes em cada item.
        unitPrice: (source % 17 === 0 ? 20 + source : 90 + ((source * 7) % 25)).toFixed(4),
        brandModel: null,
        isExpired: false,
        userId: 'u',
        now: NOW,
      }),
    ),
  );

  const run = () => {
    const assessed = assessQuotations(quotations, {
      thresholds: PARAMETERS,
      isExpiredOf: (quotation) => quotation.isExpired,
    });
    return recalculate(
      research,
      items,
      { now: NOW, userId: 'u' },
      quotationFactsByItem(assessed.quotations),
    );
  };

  it(`p95 < ${String(P95_BUDGET_MS)} ms por pesquisa (${String(ITEMS)} itens × ${String(SOURCES)} fontes)`, () => {
    for (let index = 0; index < WARMUP; index += 1) run();
    const samples: number[] = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      const startedAt = performance.now();
      const result = run();
      samples.push(performance.now() - startedAt);
      expect(result.changedItems).toHaveLength(ITEMS);
    }
    expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
  });
});
