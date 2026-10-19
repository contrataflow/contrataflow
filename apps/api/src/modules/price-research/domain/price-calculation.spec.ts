import type { PriceResearchParameters } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  calculatePriceItem,
  effectiveMethodOf,
  priceStatistics,
  sameCalculation,
  totalEstimatedValueOf,
} from './price-calculation.js';

/*
 * US-029 — motor de cálculo (RN-PRICE-41..44): 0, 1, 2 e N cotações; `AUTO_CV` nos dois ramos;
 * arredondamento com 2 e 4 casas e os dois `roundingMode`; os quatro métodos.
 */

const PARAMETERS: Pick<
  PriceResearchParameters,
  'defaultMethod' | 'cvThresholdPercent' | 'unitPriceDecimals' | 'roundingMode'
> = {
  defaultMethod: 'AUTO_CV',
  cvThresholdPercent: '25.0000',
  unitPriceDecimals: 2,
  roundingMode: 'HALF_UP',
};

const item = (overrides: Partial<Parameters<typeof calculatePriceItem>[0]> = {}) => ({
  quantity: '50.0000',
  methodOverride: null,
  manualUnitPrice: null,
  ...overrides,
});

describe('priceStatistics (RN-PRICE-41)', () => {
  it('sem cotação válida: tudo nulo e contagem 0 (FA-05)', () => {
    expect(priceStatistics([], 'HALF_UP')).toEqual({
      validQuotationsCount: 0,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      coefficientOfVariation: null,
    });
  });

  it('uma cotação: média = mediana = menor = maior; desvio e CV nulos (FA-06)', () => {
    expect(priceStatistics(['87.5000'], 'HALF_UP')).toEqual({
      validQuotationsCount: 1,
      meanPrice: '87.5000',
      medianPrice: '87.5000',
      lowestPrice: '87.5000',
      highestPrice: '87.5000',
      stdDeviation: null,
      coefficientOfVariation: null,
    });
  });

  it('duas cotações: mediana = média das centrais; desvio amostral (n − 1)', () => {
    expect(priceStatistics(['10.0000', '20.0000'], 'HALF_UP')).toEqual({
      validQuotationsCount: 2,
      meanPrice: '15.0000',
      medianPrice: '15.0000',
      lowestPrice: '10.0000',
      highestPrice: '20.0000',
      // sqrt(((10-15)² + (20-15)²) / 1) = 7.0710678…
      stdDeviation: '7.0711',
      coefficientOfVariation: '47.1405',
    });
  });

  it('cenário [Sucesso]: 100, 110 e 90 → média 100, CV 10', () => {
    expect(priceStatistics(['100.00', '110.00', '90.00'], 'HALF_UP')).toMatchObject({
      validQuotationsCount: 3,
      meanPrice: '100.0000',
      medianPrice: '100.0000',
      lowestPrice: '90.0000',
      highestPrice: '110.0000',
      stdDeviation: '10.0000',
      coefficientOfVariation: '10.0000',
    });
  });

  it('N cotações fora de ordem: ordena para a mediana; quatro valores', () => {
    expect(priceStatistics(['40', '10', '30', '20'], 'HALF_UP')).toMatchObject({
      meanPrice: '25.0000',
      medianPrice: '25.0000',
      lowestPrice: '10.0000',
      highestPrice: '40.0000',
    });
  });

  it('decimal.js, nunca float: 0.1 + 0.2 sem erro de ponto flutuante', () => {
    expect(priceStatistics(['0.1', '0.2'], 'HALF_UP').meanPrice).toBe('0.1500');
  });

  it('roundingMode na escala das estatísticas: HALF_UP × HALF_EVEN', () => {
    // média 1.00005 → HALF_UP 1.0001; HALF_EVEN 1.0000
    expect(priceStatistics(['1.0000', '1.0001'], 'HALF_UP').meanPrice).toBe('1.0001');
    expect(priceStatistics(['1.0000', '1.0001'], 'HALF_EVEN').meanPrice).toBe('1.0000');
  });
});

describe('effectiveMethodOf (RN-PRICE-42)', () => {
  const base = { cvThresholdPercent: '25.0000', coefficientOfVariation: '10.0000' };

  it('methodOverride vence o padrão (inclusive MANUAL)', () => {
    expect(effectiveMethodOf({ ...base, methodOverride: 'LOWEST', defaultMethod: 'AUTO_CV' })).toBe(
      'LOWEST',
    );
    expect(effectiveMethodOf({ ...base, methodOverride: 'MANUAL', defaultMethod: 'MEAN' })).toBe(
      'MANUAL',
    );
  });

  it('padrão fixo da pesquisa', () => {
    expect(effectiveMethodOf({ ...base, methodOverride: null, defaultMethod: 'MEDIAN' })).toBe(
      'MEDIAN',
    );
  });

  it('AUTO_CV: CV ≤ limiar → MEAN; CV > limiar → MEDIAN; igual ao limiar → MEAN', () => {
    const auto = {
      methodOverride: null,
      defaultMethod: 'AUTO_CV' as const,
      cvThresholdPercent: '25',
    };
    expect(effectiveMethodOf({ ...auto, coefficientOfVariation: '10.0000' })).toBe('MEAN');
    expect(effectiveMethodOf({ ...auto, coefficientOfVariation: '25.0000' })).toBe('MEAN');
    expect(effectiveMethodOf({ ...auto, coefficientOfVariation: '25.0001' })).toBe('MEDIAN');
  });

  it('AUTO_CV com CV indefinido (0 ou 1 cotação) → MEAN (FA-06)', () => {
    expect(
      effectiveMethodOf({
        methodOverride: null,
        defaultMethod: 'AUTO_CV',
        coefficientOfVariation: null,
        cvThresholdPercent: '25',
      }),
    ).toBe('MEAN');
  });
});

describe('calculatePriceItem (RN-PRICE-42..44)', () => {
  it('cenário [Sucesso]: CV baixo → MEAN, recomendado 100,00 e total 5000,00', () => {
    expect(calculatePriceItem(item(), ['100.00', '110.00', '90.00'], PARAMETERS)).toMatchObject({
      effectiveMethod: 'MEAN',
      recommendedUnitPrice: '100.0000',
      totalPrice: '5000.00',
    });
  });

  it('cenário CV acima do limiar: 100, 200 e 90 → MEDIAN, recomendado 100,00', () => {
    const result = calculatePriceItem(item(), ['100.00', '200.00', '90.00'], PARAMETERS);
    expect(Number(result.coefficientOfVariation)).toBeGreaterThan(25);
    expect(result).toMatchObject({ effectiveMethod: 'MEDIAN', recommendedUnitPrice: '100.0000' });
  });

  it('LOWEST usa a menor cotação', () => {
    expect(
      calculatePriceItem(item({ methodOverride: 'LOWEST' }), ['100', '90', '95'], PARAMETERS),
    ).toMatchObject({
      effectiveMethod: 'LOWEST',
      recommendedUnitPrice: '90.0000',
      totalPrice: '4500.00',
    });
  });

  it('MANUAL usa o valor informado, mesmo sem cotações (FA-01)', () => {
    expect(
      calculatePriceItem(
        item({ methodOverride: 'MANUAL', manualUnitPrice: '123.4567', quantity: '2.0000' }),
        [],
        PARAMETERS,
      ),
    ).toMatchObject({
      validQuotationsCount: 0,
      effectiveMethod: 'MANUAL',
      recommendedUnitPrice: '123.4567',
      totalPrice: '246.91',
    });
  });

  it('MANUAL sem valor (estado impossível pelo CHECK): recomendado nulo', () => {
    expect(
      calculatePriceItem(item({ methodOverride: 'MANUAL' }), ['10'], PARAMETERS),
    ).toMatchObject({ recommendedUnitPrice: null, totalPrice: null });
  });

  it('sem cotação válida: método gravado e recomendado/total nulos (RN-PRICE-42 · FA-05)', () => {
    for (const methodOverride of [null, 'MEAN', 'MEDIAN', 'LOWEST'] as const) {
      expect(calculatePriceItem(item({ methodOverride }), [], PARAMETERS)).toMatchObject({
        effectiveMethod: methodOverride ?? 'MEAN',
        recommendedUnitPrice: null,
        totalPrice: null,
      });
    }
  });

  it('arredondamento: 2 casas × 4 casas, HALF_UP × HALF_EVEN, sem arredondar duas vezes', () => {
    // média = 10.125 (exata): 2 casas HALF_UP 10.13, HALF_EVEN 10.12; 4 casas mantém 10.1250.
    const prices = ['10.1000', '10.1500'];
    expect(calculatePriceItem(item(), prices, PARAMETERS).recommendedUnitPrice).toBe('10.1300');
    expect(
      calculatePriceItem(item(), prices, { ...PARAMETERS, roundingMode: 'HALF_EVEN' })
        .recommendedUnitPrice,
    ).toBe('10.1200');
    expect(
      calculatePriceItem(item(), prices, { ...PARAMETERS, unitPriceDecimals: 4 })
        .recommendedUnitPrice,
    ).toBe('10.1250');
  });

  it('total = round(recomendado × quantidade, 2) pelo roundingMode', () => {
    // 10.13 × 0.5 = 5.065 → HALF_UP 5.07; HALF_EVEN com recomendado 10.12 × 0.5 = 5.06
    expect(
      calculatePriceItem(item({ quantity: '0.5000' }), ['10.1000', '10.1500'], PARAMETERS)
        .totalPrice,
    ).toBe('5.07');
    expect(
      calculatePriceItem(item({ quantity: '0.2500' }), ['10.1300'], {
        ...PARAMETERS,
        roundingMode: 'HALF_EVEN',
      }).totalPrice,
    ).toBe('2.53');
  });
});

describe('totalEstimatedValueOf e sameCalculation', () => {
  it('soma os totais calculados; nulo se nenhum item tem total', () => {
    expect(
      totalEstimatedValueOf([
        { totalPrice: '10.50' },
        { totalPrice: null },
        { totalPrice: '0.25' },
      ]),
    ).toBe('10.75');
    expect(totalEstimatedValueOf([{ totalPrice: null }])).toBeNull();
    expect(totalEstimatedValueOf([])).toBeNull();
  });

  it('compara campo a campo', () => {
    const result = calculatePriceItem(item(), ['10'], PARAMETERS);
    expect(sameCalculation(result, { ...result })).toBe(true);
    expect(sameCalculation(result, { ...result, totalPrice: '1.00' })).toBe(false);
  });
});
