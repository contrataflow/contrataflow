import { describe, expect, it } from 'vitest';

import { flagOutlier, outlierFlagsOf } from './price-calculation.js';
import {
  consolidateAlerts,
  createPriceItem,
  createPriceResearch,
  NO_QUOTATIONS,
  parametersSnapshot,
  recalculate,
  recalculateItem,
} from './price-research.js';
import type { ItemQuotationFacts, PriceItem } from './price-research.js';
import {
  assessQuotations,
  createQuotation,
  excludeQuotation,
  quotationFactsByItem,
} from './price-source.js';
import type { Quotation } from './price-source.js';

/*
 * US-030 — regras puras de destaque e alertas: `flagOutlier` contra a mediana das DEMAIS cotações
 * válidas (RN-PRICE-48) nas três faixas e com menos de 2 outras, a avaliação de todas as cotações
 * (`EXCLUDED` como inexistente — RN-PRICE-52 — e a validade pela regra do tipo — RN-PRICE-49), a
 * consolidação dos cinco alertas isolados e combinados (RN-PRICE-50/51) e a idempotência do
 * recálculo. Nenhuma cotação é excluída automaticamente em nenhum caso (DEC-020).
 */

const NOW = new Date('2026-10-06T12:00:00.000Z');
const STAMP = { now: NOW, userId: 'u' };
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
const THRESHOLDS = { outlierLowerPercent: '70.0000', outlierUpperPercent: '130.0000' };

const quotation = (id: string, unitPrice: string, priceItemId = 'item-1'): Quotation =>
  createQuotation({
    id,
    tenantId: 't',
    priceResearchId: 'r',
    priceItemId,
    priceSourceId: `s-${id}`,
    unitPrice,
    brandModel: null,
    isExpired: false,
    userId: 'u',
    now: NOW,
  });

const exclude = (target: Quotation) =>
  excludeQuotation(target, {
    reason: 'INCONSISTENT',
    justification: 'Preço incompatível com o praticado no mercado.',
    userId: 'u',
    now: NOW,
  });

const codes = (alerts: readonly { readonly code: string }[]) => alerts.map((alert) => alert.code);

describe('flagOutlier (RN-PRICE-48)', () => {
  it('abaixo do limite inferior da mediana das demais → LOW', () => {
    // Mediana das demais = 100; 70% = 70.
    expect(flagOutlier('40.0000', ['100.0000', '100.0000'], THRESHOLDS)).toBe('LOW');
    expect(flagOutlier('69.9999', ['100.0000', '100.0000'], THRESHOLDS)).toBe('LOW');
  });

  it('acima do limite superior → HIGH', () => {
    expect(flagOutlier('130.0001', ['100.0000', '100.0000'], THRESHOLDS)).toBe('HIGH');
    expect(flagOutlier('500.0000', ['90.0000', '100.0000', '110.0000'], THRESHOLDS)).toBe('HIGH');
  });

  it('dentro da faixa (inclusive nos limites exatos) → NONE', () => {
    expect(flagOutlier('70.0000', ['100.0000', '100.0000'], THRESHOLDS)).toBe('NONE');
    expect(flagOutlier('130.0000', ['100.0000', '100.0000'], THRESHOLDS)).toBe('NONE');
    expect(flagOutlier('105.0000', ['90.0000', '110.0000'], THRESHOLDS)).toBe('NONE');
  });

  it('com menos de 2 outras cotações a comparação não é confiável → NONE', () => {
    expect(flagOutlier('1.0000', [], THRESHOLDS)).toBe('NONE');
    expect(flagOutlier('1.0000', ['100.0000'], THRESHOLDS)).toBe('NONE');
  });

  it('mediana das demais com quantidade par (média dos centrais) e limiares do snapshot', () => {
    // Demais 80, 100, 120, 140 → mediana 110; 50% = 55, 150% = 165.
    const loose = { outlierLowerPercent: '50.0000', outlierUpperPercent: '150.0000' };
    const others = ['80.0000', '100.0000', '120.0000', '140.0000'];
    expect(flagOutlier('54.9999', others, loose)).toBe('LOW');
    expect(flagOutlier('55.0000', others, loose)).toBe('NONE');
    expect(flagOutlier('165.0001', others, loose)).toBe('HIGH');
  });

  it('outlierFlagsOf: cada cotação contra as demais (Gherkin: 100, 100 e 40)', () => {
    const flags = outlierFlagsOf(
      [
        { id: 'a', unitPrice: '100.0000' },
        { id: 'b', unitPrice: '100.0000' },
        { id: 'c', unitPrice: '40.0000' },
      ],
      THRESHOLDS,
    );
    expect(flags.get('c')).toBe('LOW');
    // As de 100 comparam com a mediana de (100, 40) = 70 → 100 > 91 (130%).
    expect(flags.get('a')).toBe('HIGH');
    expect(flags.size).toBe(3);
  });
});

describe('assessQuotations (RN-PRICE-48/49/52)', () => {
  it('marca o destaque por item, sem excluir nenhuma cotação (DEC-020)', () => {
    const stored = [
      quotation('a', '100.0000'),
      quotation('b', '100.0000'),
      quotation('c', '40.0000'),
      quotation('d', '10.0000', 'item-2'),
    ];
    const result = assessQuotations(stored, { thresholds: THRESHOLDS, isExpiredOf: () => false });
    expect(result.quotations.map((q) => [q.id, q.status, q.outlierFlag])).toEqual([
      ['a', 'VALID', 'HIGH'],
      ['b', 'VALID', 'HIGH'],
      ['c', 'VALID', 'LOW'],
      // Item 2 com uma cotação só: nada a comparar.
      ['d', 'VALID', 'NONE'],
    ]);
    expect(result.changed.map((q) => q.id)).toEqual(['a', 'b', 'c']);
    expect(result.quotations.every((q) => q.status === 'VALID')).toBe(true);
  });

  it('EXCLUDED não entra na mediana das demais e fica NONE (FA-01)', () => {
    const distorting = { ...exclude(quotation('c', '40.0000')), outlierFlag: 'LOW' as const };
    const stored = [
      quotation('a', '100.0000'),
      quotation('b', '100.0000'),
      quotation('e', '105.0000'),
      distorting,
    ];
    const result = assessQuotations(stored, { thresholds: THRESHOLDS, isExpiredOf: () => false });
    expect(result.quotations.map((q) => [q.id, q.outlierFlag])).toEqual([
      ['a', 'NONE'],
      ['b', 'NONE'],
      ['e', 'NONE'],
      ['c', 'NONE'],
    ]);
    expect(result.quotations.find((q) => q.id === 'c')?.status).toBe('EXCLUDED');
    expect(result.changed.map((q) => q.id)).toEqual(['c']);
  });

  it('validade pela regra do tipo (callback); avaliação idêntica não muda nada', () => {
    const stored = [quotation('a', '100.0000'), quotation('b', '100.0000')];
    const expired = assessQuotations(stored, {
      thresholds: THRESHOLDS,
      isExpiredOf: (q) => q.id === 'a',
    });
    expect(expired.quotations.map((q) => q.isExpired)).toEqual([true, false]);
    expect(expired.changed.map((q) => q.id)).toEqual(['a']);
    const again = assessQuotations(expired.quotations, {
      thresholds: THRESHOLDS,
      isExpiredOf: (q) => q.id === 'a',
    });
    expect(again.changed).toEqual([]);
    expect(again.quotations[0]).toBe(expired.quotations[0]);
  });

  it('quotationFactsByItem: preços das VALID, destaque e validade só das VALID', () => {
    const stale = { ...exclude(quotation('x', '1.0000')), outlierFlag: 'LOW' as const };
    const facts = quotationFactsByItem([
      quotation('a', '100.0000'),
      { ...quotation('b', '200.0000'), outlierFlag: 'HIGH' },
      { ...stale, isExpired: true },
      { ...quotation('c', '50.0000', 'item-2'), isExpired: true },
    ]);
    expect(facts.get('item-1')).toEqual({
      validPrices: ['100.0000', '200.0000'],
      hasOutliers: true,
      hasExpired: false,
    });
    expect(facts.get('item-2')).toEqual({
      validPrices: ['50.0000'],
      hasOutliers: false,
      hasExpired: true,
    });
  });
});

describe('consolidateAlerts (RN-PRICE-50)', () => {
  const alerts = (input: Partial<Parameters<typeof consolidateAlerts>[0]>) =>
    codes(
      consolidateAlerts(
        {
          validQuotationsCount: 3,
          coefficientOfVariation: '10.0000',
          hasOutliers: false,
          hasExpired: false,
          ...input,
        },
        PARAMETERS,
      ),
    );

  it('cada alerta isolado', () => {
    expect(alerts({ validQuotationsCount: 0, coefficientOfVariation: null })).toEqual([
      'NO_VALID_QUOTES',
    ]);
    expect(alerts({ validQuotationsCount: 1, coefficientOfVariation: null })).toEqual([
      'BELOW_MINIMUM_QUOTES',
    ]);
    expect(alerts({ coefficientOfVariation: '25.0001' })).toEqual(['HIGH_CV']);
    expect(alerts({ hasOutliers: true })).toEqual(['HAS_OUTLIERS']);
    expect(alerts({ hasExpired: true })).toEqual(['EXPIRED_QUOTES']);
    expect(alerts({})).toEqual([]);
  });

  it('FA-03: exatamente o mínimo não gera BELOW_MINIMUM_QUOTES; CV igual ao limiar não é alto', () => {
    expect(alerts({ validQuotationsCount: 3 })).toEqual([]);
    expect(alerts({ validQuotationsCount: 2 })).toEqual(['BELOW_MINIMUM_QUOTES']);
    expect(alerts({ coefficientOfVariation: '25.0000' })).toEqual([]);
  });

  it('HIGH_CV só com 2 ou mais cotações válidas', () => {
    expect(alerts({ validQuotationsCount: 1, coefficientOfVariation: '90.0000' })).toEqual([
      'BELOW_MINIMUM_QUOTES',
    ]);
    expect(alerts({ validQuotationsCount: 2, coefficientOfVariation: '90.0000' })).toEqual([
      'BELOW_MINIMUM_QUOTES',
      'HIGH_CV',
    ]);
  });

  it('FA-04: alertas combinados coexistem, cada um uma vez, na ordem do catálogo', () => {
    expect(
      alerts({
        validQuotationsCount: 2,
        coefficientOfVariation: '40.0000',
        hasOutliers: true,
        hasExpired: true,
      }),
    ).toEqual(['BELOW_MINIMUM_QUOTES', 'HIGH_CV', 'HAS_OUTLIERS', 'EXPIRED_QUOTES']);
    expect(
      alerts({ coefficientOfVariation: '40.0000', hasOutliers: true, hasExpired: true }),
    ).toEqual(['HIGH_CV', 'HAS_OUTLIERS', 'EXPIRED_QUOTES']);
  });
});

describe('recálculo com alertas (RN-PRICE-50/51)', () => {
  const item = (id: string): PriceItem =>
    createPriceItem(
      { processItemId: id, sequence: 1, quantity: '10.0000' },
      { id, tenantId: 't', priceResearchId: 'r', parameters: PARAMETERS, userId: 'u', now: NOW },
    );
  const research = (items: readonly PriceItem[]) =>
    createPriceResearch(
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
  const factsOf = (stored: readonly Quotation[]) =>
    quotationFactsByItem(
      assessQuotations(stored, { thresholds: THRESHOLDS, isExpiredOf: () => false }).quotations,
    );

  it('item sem cotação válida: NO_VALID_QUOTES e recomendado nulo', () => {
    const recalculated = recalculateItem(item('item-2'), NO_QUOTATIONS, PARAMETERS, STAMP);
    expect(codes(recalculated.alerts)).toEqual(['NO_VALID_QUOTES']);
    expect(recalculated.recommendedUnitPrice).toBeNull();
  });

  it('HAS_OUTLIERS com 100, 100 e 40; [Duplicidade] o segundo recálculo não muda nada', () => {
    const items = [item('item-1'), item('item-2')];
    const facts = factsOf([
      quotation('a', '100.0000'),
      quotation('b', '100.0000'),
      quotation('c', '40.0000'),
    ]);
    const first = recalculate(research(items), items, STAMP, facts);
    const outlier = first.changedItems.find((changed) => changed.id === 'item-1');
    expect(codes(outlier?.alerts ?? [])).toEqual(['HIGH_CV', 'HAS_OUTLIERS']);
    expect(first.research.itemsWithAlertsCount).toBe(2);

    const current = items.map(
      (candidate) => first.changedItems.find((changed) => changed.id === candidate.id) ?? candidate,
    );
    const second = recalculate(first.research, current, STAMP, facts);
    expect(second.changedItems).toEqual([]);
    expect(codes(current[0]?.alerts ?? []).filter((code) => code === 'HAS_OUTLIERS')).toHaveLength(
      1,
    );
    expect(second.research.itemsWithAlertsCount).toBe(2);
  });

  it('FA-01: sem a cotação destoante (EXCLUDED) o item perde HAS_OUTLIERS', () => {
    const facts: ReadonlyMap<string, ItemQuotationFacts> = factsOf([
      quotation('a', '100.0000'),
      quotation('b', '100.0000'),
      quotation('e', '105.0000'),
      exclude(quotation('c', '40.0000')),
    ]);
    const recalculated = recalculateItem(
      { ...item('item-1'), alerts: [{ code: 'HAS_OUTLIERS' }] },
      facts.get('item-1') ?? NO_QUOTATIONS,
      PARAMETERS,
      STAMP,
    );
    expect(codes(recalculated.alerts)).toEqual([]);
    expect(recalculated.validQuotationsCount).toBe(3);
  });
});
