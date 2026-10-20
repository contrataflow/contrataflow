import { describe, expect, it } from 'vitest';

import {
  canRemoveItem,
  consolidateAlerts,
  countersOf,
  createPriceItem,
  createPriceResearch,
  defaultQuantity,
  parametersSnapshot,
  planPriceItems,
  PRICE_RESEARCH_SETTING_KEYS,
  recalculate,
  referenceDateErrors,
  withReferenceDate,
} from './price-research.js';
import type { PriceItem, ResearchableItem } from './price-research.js';

/*
 * US-024 — regras puras da pesquisa de preços: snapshot (RN-PRICE-05), quantidade padrão e regra
 * da unidade (RN-PRICE-04 · V-04), seleção/inclusão de itens (RN-PRICE-03/11 · V-02), data-base
 * (RN-PRICE-06 · V-05), alertas iniciais e contadores (US-029/US-030) e o último item (V-10).
 */

const NOW = new Date('2026-10-06T12:00:00.000Z');
const SETTINGS = new Map<string, unknown>([
  ['priceResearch.defaultMethod', 'AUTO_CV'],
  ['priceResearch.cvThresholdPercent', 25],
  ['priceResearch.minQuotations', 3],
  ['priceResearch.directQuoteMaxAgeDays', 180],
  ['priceResearch.similarContractMaxAgeDays', 365],
  ['priceResearch.outlierLowerPercent', 70],
  ['priceResearch.outlierUpperPercent', 130],
  ['priceResearch.unitPriceDecimals', 2],
  ['priceResearch.roundingMode', 'HALF_UP'],
]);

const cement: ResearchableItem = {
  id: 'i1',
  sequence: 1,
  allowsDecimal: false,
  defaultQuantity: '100',
};
const sand: ResearchableItem = {
  id: 'i2',
  sequence: 2,
  allowsDecimal: true,
  defaultQuantity: '12',
};
const gravel: ResearchableItem = {
  id: 'i3',
  sequence: 3,
  allowsDecimal: true,
  defaultQuantity: null,
};

describe('Snapshot dos parâmetros (RN-PRICE-05)', () => {
  it('copia as nove chaves com percentuais em numeric(9,4)', () => {
    expect(PRICE_RESEARCH_SETTING_KEYS).toHaveLength(9);
    expect(parametersSnapshot(SETTINGS)).toEqual({
      defaultMethod: 'AUTO_CV',
      cvThresholdPercent: '25.0000',
      minQuotations: 3,
      directQuoteMaxAgeDays: 180,
      similarContractMaxAgeDays: 365,
      outlierLowerPercent: '70.0000',
      outlierUpperPercent: '130.0000',
      unitPriceDecimals: 2,
      roundingMode: 'HALF_UP',
    });
  });

  it('configuração corrompida falha explicitamente (nunca snapshot parcial)', () => {
    const broken = new Map(SETTINGS);
    broken.set('priceResearch.minQuotations', 'três');
    expect(() => parametersSnapshot(broken)).toThrow(/minQuotations/);
    const decimals = new Map(SETTINGS);
    decimals.set('priceResearch.unitPriceDecimals', 3);
    expect(() => parametersSnapshot(decimals)).toThrow(/unitPriceDecimals/);
  });
});

describe('Quantidade padrão (RN-PRICE-04)', () => {
  it('processo → ETP/DFD → obrigatória', () => {
    expect(defaultQuantity('100.0000', '6.0000')).toBe('100.0000');
    expect(defaultQuantity(null, '6.0000')).toBe('6.0000');
    expect(defaultQuantity(null, undefined)).toBeNull();
  });
});

describe('Seleção de itens (RN-PRICE-03/04/11)', () => {
  it('sem lista: todos os itens por sequence, quantidades normalizadas', () => {
    const plan = planPriceItems({ requested: undefined, available: [sand, cement] });
    expect(plan.errors).toEqual([]);
    expect(plan.lines).toEqual([
      { processItemId: 'i1', sequence: 1, quantity: '100.0000' },
      { processItemId: 'i2', sequence: 2, quantity: '12.0000' },
    ]);
  });

  it('item sem quantidade padrão exige a quantidade (REQUIRED) na posição da lista', () => {
    const plan = planPriceItems({ requested: undefined, available: [cement, sand, gravel] });
    expect(plan.errors).toEqual([
      expect.objectContaining({ field: 'items[2].quantity', code: 'REQUIRED' }),
    ]);
    const informed = planPriceItems({
      requested: [{ processItemId: 'i3', quantity: '6' }],
      available: [cement, sand, gravel],
    });
    expect(informed.lines).toEqual([{ processItemId: 'i3', sequence: 3, quantity: '6.0000' }]);
  });

  it('V-04: zero, mais de 4 casas e fração em unidade inteira', () => {
    const plan = planPriceItems({
      requested: [
        { processItemId: 'i2', quantity: '0' },
        { processItemId: 'i2x', quantity: '1' },
        { processItemId: 'i3', quantity: '1.23456' },
        { processItemId: 'i1', quantity: '2.5' },
      ],
      available: [cement, sand, gravel],
    });
    expect(plan.errors.map((error) => [error.field, error.code])).toEqual([
      ['items[0].quantity', 'OUT_OF_RANGE'],
      ['items[1].processItemId', 'REFERENCE_NOT_FOUND'],
      ['items[2].quantity', 'INVALID_DECIMAL'],
      ['items[3].quantity', 'INVALID_DECIMAL'],
    ]);
    expect(plan.errors[3]?.message).toBe('Esta unidade aceita apenas números inteiros.');
    expect(plan.errors[0]?.message).toBe(
      'Informe uma quantidade maior que zero (até 4 casas decimais).',
    );
  });

  it('inclusão (PRS-06): item já presente na pesquisa → DUPLICATE_IN_LIST', () => {
    const plan = planPriceItems({
      requested: [{ processItemId: 'i1' }, { processItemId: 'i2' }],
      available: [cement, sand],
      alreadyIncluded: new Set(['i1']),
    });
    expect(plan.errors).toEqual([
      expect.objectContaining({ field: 'items[0].processItemId', code: 'DUPLICATE_IN_LIST' }),
    ]);
    expect(plan.lines.map((line) => line.processItemId)).toEqual(['i2']);
  });
});

describe('Data-base (RN-PRICE-06)', () => {
  it('hoje ou passado vale; futura → OUT_OF_RANGE', () => {
    expect(referenceDateErrors('2026-10-06', '2026-10-06')).toEqual([]);
    expect(referenceDateErrors('2026-09-30', '2026-10-06')).toEqual([]);
    expect(referenceDateErrors('2026-10-10', '2026-10-06')).toEqual([
      {
        field: 'referenceDate',
        code: 'OUT_OF_RANGE',
        message: 'A data-base não pode ser posterior a hoje.',
      },
    ]);
  });
});

describe('Alertas, contadores e criação', () => {
  const parameters = parametersSnapshot(SETTINGS);
  const item = (id: string, sequence: number): PriceItem =>
    createPriceItem(
      { processItemId: id, sequence, quantity: '1.0000' },
      { id: `p-${id}`, tenantId: 't', priceResearchId: 'r', parameters, userId: 'u', now: NOW },
    );

  it('sem cotações: só NO_VALID_QUOTES (RN-PRICE-50); abaixo do mínimo: BELOW_MINIMUM_QUOTES; com o mínimo, nenhum', () => {
    const alerts = (validQuotationsCount: number) =>
      consolidateAlerts(
        {
          validQuotationsCount,
          coefficientOfVariation: null,
          hasOutliers: false,
          hasExpired: false,
        },
        parameters,
      ).map((alert) => alert.code);
    expect(alerts(0)).toEqual(['NO_VALID_QUOTES']);
    expect(alerts(2)).toEqual(['BELOW_MINIMUM_QUOTES']);
    expect(alerts(3)).toEqual([]);
  });

  it('PriceItem.create: sortOrder = sequence, sem cotações, versão 1', () => {
    expect(item('i3', 3)).toMatchObject({
      sortOrder: 3,
      validQuotationsCount: 0,
      recommendedUnitPrice: null,
      alerts: [{ code: 'NO_VALID_QUOTES' }],
      version: 1,
    });
  });

  it('PriceResearch.create: id = documento, contadores pelas linhas', () => {
    const items = [item('i1', 1), item('i2', 2)];
    const research = createPriceResearch(
      {
        documentId: 'd',
        tenantId: 't',
        processId: 'p',
        referenceDate: '2026-10-06',
        parameters,
        creatorId: 'u',
        now: NOW,
      },
      items,
    );
    expect(research).toMatchObject({
      id: 'd',
      documentId: 'd',
      itemsCount: 2,
      itemsWithAlertsCount: 2,
      totalEstimatedValue: null,
      completedAt: null,
      version: 1,
    });
    expect(countersOf([...items, { alerts: [] }])).toEqual({
      itemsCount: 3,
      itemsWithAlertsCount: 2,
    });
  });

  it('recálculo (FA-07): reavalia alertas, contadores e lastCalculatedAt', () => {
    const first = item('i1', 1);
    const second: PriceItem = { ...item('i2', 2), validQuotationsCount: 3, alerts: [] };
    const items = [first, second];
    const stale: PriceItem = { ...first, alerts: [] };
    const research = withReferenceDate(
      createPriceResearch(
        {
          documentId: 'd',
          tenantId: 't',
          processId: 'p',
          referenceDate: '2026-10-06',
          parameters,
          creatorId: 'u',
          now: NOW,
        },
        items,
      ),
      '2026-10-01',
    );
    const later = new Date('2026-10-07T00:00:00.000Z');
    const result = recalculate(
      research,
      [stale, second],
      { now: later, userId: 'v' },
      new Map([
        [
          'p-i2',
          {
            validPrices: ['10.0000', '12.0000', '11.0000'],
            hasOutliers: false,
            hasExpired: false,
          },
        ],
      ]),
    );
    expect(result.research).toMatchObject({
      referenceDate: '2026-10-01',
      itemsCount: 2,
      itemsWithAlertsCount: 1,
      lastCalculatedAt: later,
      updatedById: 'v',
    });
    // i1 ganha os alertas; i2 ganha as estatísticas (US-029).
    expect(result.changedItems.map((changed) => changed.id)).toEqual(['p-i1', 'p-i2']);
  });

  it('V-10: o último item não pode ser removido', () => {
    expect(canRemoveItem(2)).toBe(true);
    expect(canRemoveItem(1)).toBe(false);
  });
});
