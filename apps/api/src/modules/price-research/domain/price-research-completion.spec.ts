import { describe, expect, it } from 'vitest';

import {
  completedSummary,
  completeResearch,
  completionReference,
  completionViolations,
  referenceUnitPriceOf,
} from './price-research-completion.js';
import type { PriceItem, PriceResearch } from './price-research.js';

/*
 * US-032 — `PriceResearch.complete` (RN-PRICE-58..63): completude por item, valores propagados ao
 * processo, cabeçalho concluído e o `typedSummary` do `PriceResearchCompleted`.
 */

const AT = new Date('2026-10-06T15:00:00.000Z');
const ACTOR = '0192a000-0000-7000-8000-0000000000f1';
const REASON = 'Mercado restrito na região.';

function item(overrides: Partial<PriceItem> & Pick<PriceItem, 'id' | 'processItemId'>): PriceItem {
  return {
    tenantId: 't',
    priceResearchId: 'r',
    quantity: '50.0000',
    methodOverride: null,
    effectiveMethod: 'MEAN',
    validQuotationsCount: 3,
    meanPrice: '100.0000',
    medianPrice: '100.0000',
    lowestPrice: '100.0000',
    highestPrice: '100.0000',
    stdDeviation: '0.0000',
    coefficientOfVariation: '0.0000',
    recommendedUnitPrice: '100.0000',
    manualUnitPrice: null,
    manualJustification: null,
    totalPrice: '5000.00',
    belowMinimumJustification: null,
    alerts: [],
    notes: null,
    sortOrder: 1,
    calculatedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

const ITEM_1 = item({ id: 'i1', processItemId: 'p1', sortOrder: 1 });
const ITEM_2 = item({
  id: 'i2',
  processItemId: 'p2',
  sortOrder: 2,
  quantity: '100.0000',
  recommendedUnitPrice: '40.0000',
  totalPrice: '4000.00',
});
const SEQUENCES = new Map([
  ['p1', 1],
  ['p2', 2],
]);

describe('completionViolations (RN-PRICE-58/59)', () => {
  it('todos os itens completos: nenhuma violação', () => {
    expect(completionViolations([ITEM_1, ITEM_2], SEQUENCES, 3)).toEqual([]);
  });

  it('sem preço recomendado → PRICE_ITEM_WITHOUT_PRICE com itemId, nº e mensagem', () => {
    const pending = { ...ITEM_2, recommendedUnitPrice: null, validQuotationsCount: 0 };
    expect(completionViolations([ITEM_1, pending], SEQUENCES, 3)).toEqual([
      {
        code: 'PRICE_ITEM_WITHOUT_PRICE',
        severity: 'BLOCKING',
        message: 'O item "Item 2" não tem preço calculado. Registre cotações ou um valor manual.',
        ruleId: 'RN-PRICE-58',
        sectionKey: null,
        field: null,
        itemId: 'i2',
        params: { sequence: 2, processItemId: 'p2' },
      },
    ]);
  });

  it('valor manual sem nenhuma cotação válida também bloqueia (nenhuma justificativa substitui)', () => {
    const manual = {
      ...ITEM_2,
      effectiveMethod: 'MANUAL' as const,
      manualUnitPrice: '41.0000',
      recommendedUnitPrice: '41.0000',
      validQuotationsCount: 0,
      belowMinimumJustification: REASON,
    };
    expect(completionViolations([manual], SEQUENCES, 3)).toMatchObject([
      {
        code: 'PRICE_ITEM_WITHOUT_PRICE',
        message: 'O item "Item 2" não tem cotação válida. Registre ao menos uma cotação válida.',
      },
    ]);
  });

  it('abaixo do mínimo: sem justificativa bloqueia; com justificativa (FA-02) passa', () => {
    const below = { ...ITEM_2, validQuotationsCount: 1 };
    expect(completionViolations([below], SEQUENCES, 3)).toMatchObject([
      {
        code: 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED',
        field: 'belowMinimumJustification',
        itemId: 'i2',
      },
    ]);
    expect(
      completionViolations([{ ...below, belowMinimumJustification: '   ' }], SEQUENCES, 3),
    ).toHaveLength(1);
    expect(
      completionViolations([{ ...below, belowMinimumJustification: REASON }], SEQUENCES, 3),
    ).toEqual([]);
    expect(completionViolations([below], SEQUENCES, 1)).toEqual([]);
  });

  it('uma violação por item pendente, todas de uma vez, na ordem dos itens; nº do item na falta da sequência', () => {
    const violations = completionViolations(
      [
        { ...ITEM_2, validQuotationsCount: 2 },
        { ...ITEM_1, recommendedUnitPrice: null },
      ],
      new Map([['p2', 7]]),
      3,
    );
    expect(violations.map((violation) => [violation.itemId, violation.code])).toEqual([
      ['i1', 'PRICE_ITEM_WITHOUT_PRICE'],
      ['i2', 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED'],
    ]);
    expect(violations.map((violation) => violation.params.sequence)).toEqual([1, 7]);
  });
});

describe('referenceUnitPriceOf / completionReference (RN-PRICE-61/62)', () => {
  it('preço recomendado; com MANUAL, o valor manual', () => {
    expect(referenceUnitPriceOf(ITEM_1)).toBe('100.0000');
    expect(
      referenceUnitPriceOf({
        ...ITEM_1,
        effectiveMethod: 'MANUAL',
        manualUnitPrice: '95.5',
        recommendedUnitPrice: '95.5000',
      }),
    ).toBe('95.5000');
    expect(referenceUnitPriceOf({ ...ITEM_1, recommendedUnitPrice: null })).toBeNull();
  });

  it('preço de cada item do processo e a soma dos totais', () => {
    expect(completionReference([ITEM_1, ITEM_2])).toEqual({
      unitPrices: [
        { processItemId: 'p1', unitPrice: '100.0000' },
        { processItemId: 'p2', unitPrice: '40.0000' },
      ],
      estimatedValue: '9000.00',
    });
    expect(completionReference([])).toEqual({ unitPrices: [], estimatedValue: '0.00' });
  });
});

describe('completeResearch / completedSummary (RN-PRICE-60/63)', () => {
  const research = {
    id: 'r',
    itemsCount: 2,
    itemsWithAlertsCount: 1,
    completedAt: null,
    completedById: null,
    updatedAt: new Date(0),
    updatedById: null,
  } as unknown as PriceResearch;

  it('preenche completedAt/completedById e a autoria', () => {
    expect(completeResearch(research, { actorId: ACTOR, now: AT })).toMatchObject({
      completedAt: AT,
      completedById: ACTOR,
      updatedAt: AT,
      updatedById: ACTOR,
    });
  });

  it('typedSummary só com contadores e a marca de sigilo', () => {
    expect(completedSummary(research, false)).toEqual({
      totalEstimatedValueMasked: false,
      itemsCount: 2,
      itemsWithAlertsCount: 1,
    });
    expect(completedSummary(research, true).totalEstimatedValueMasked).toBe(true);
  });
});
