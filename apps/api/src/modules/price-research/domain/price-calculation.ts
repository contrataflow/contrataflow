import type {
  OutlierFlag,
  PriceCalculationMethod,
  PriceDefaultMethod,
  PriceResearchParameters,
  PriceRoundingMode,
} from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

/*
 * Motor de cálculo da pesquisa de preços (US-029 · RN-PRICE-41..47 · DEC-020 · DEC-003). Funções
 * puras sobre strings decimais: estatísticas das cotações válidas de um item, método efetivo
 * (`AUTO_CV` → mediana quando o CV supera o limiar), preço recomendado arredondado pelo snapshot e
 * total do item. Toda aritmética em `decimal.js` com contexto fixo de 28 dígitos — nunca `number`.
 */

/** Contexto próprio (não altera o `Decimal` global): mesmo resultado em qualquer ambiente. */
const D = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

/** Escalas das colunas (entities.md §`PriceItem`): preços e desvio (18,4), CV (9,4), total (18,2). */
const PRICE_SCALE = 4;
const PERCENT_SCALE = 4;
const MONEY_SCALE = 2;

const ROUNDING: Readonly<Record<PriceRoundingMode, Decimal.Rounding>> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
};

/** RN-PRICE-41: estatísticas das cotações válidas (strings na escala da coluna). */
export interface PriceStatistics {
  readonly validQuotationsCount: number;
  readonly meanPrice: string | null;
  readonly medianPrice: string | null;
  readonly lowestPrice: string | null;
  readonly highestPrice: string | null;
  /** Amostral (denominador `n − 1`); `null` com menos de 2 cotações. */
  readonly stdDeviation: string | null;
  /** `stdDeviation / meanPrice × 100`; `null` com menos de 2 cotações. */
  readonly coefficientOfVariation: string | null;
}

/** Os valores sem arredondamento: o recomendado parte deles (sem arredondar duas vezes). */
interface RawStatistics {
  readonly count: number;
  readonly mean: Dec | null;
  readonly median: Dec | null;
  readonly lowest: Dec | null;
  readonly highest: Dec | null;
  readonly stdDeviation: Dec | null;
  readonly cv: Dec | null;
}

/** Mediana de valores já ordenados; `null` sem valores. */
function medianOfSorted(values: readonly Dec[]): Dec | null {
  const count = values.length;
  if (count === 0) return null;
  const middle = Math.floor(count / 2);
  const upper = values[middle];
  if (upper === undefined) return null;
  return count % 2 === 1 ? upper : (values[middle - 1] ?? upper).plus(upper).dividedBy(2);
}

function rawStatistics(prices: readonly string[]): RawStatistics {
  const values = prices.map((price) => new D(price)).sort((a, b) => a.comparedTo(b));
  const count = values.length;
  const first = values[0];
  const last = values[count - 1];
  if (first === undefined || last === undefined) {
    return {
      count: 0,
      mean: null,
      median: null,
      lowest: null,
      highest: null,
      stdDeviation: null,
      cv: null,
    };
  }
  const mean = values.reduce((sum, value) => sum.plus(value), new D(0)).dividedBy(count);
  const median = medianOfSorted(values) ?? first;
  if (count < 2) {
    return { count, mean, median, lowest: first, highest: last, stdDeviation: null, cv: null };
  }
  const squares = values.reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), new D(0));
  const stdDeviation = squares.dividedBy(count - 1).sqrt();
  // Média zero não ocorre (preço > 0 — V-03 da US-026); a guarda evita divisão por zero.
  const cv = mean.isZero() ? null : stdDeviation.dividedBy(mean).times(100);
  return { count, mean, median, lowest: first, highest: last, stdDeviation, cv };
}

const fixed = (value: Dec | null, scale: number, rounding: Decimal.Rounding) =>
  value === null ? null : value.toFixed(scale, rounding);

/** RN-PRICE-41 · RN-PRICE-44: as estatísticas arredondadas pelo `roundingMode` do snapshot. */
export function priceStatistics(
  prices: readonly string[],
  roundingMode: PriceRoundingMode,
): PriceStatistics {
  const raw = rawStatistics(prices);
  const rounding = ROUNDING[roundingMode];
  return {
    validQuotationsCount: raw.count,
    meanPrice: fixed(raw.mean, PRICE_SCALE, rounding),
    medianPrice: fixed(raw.median, PRICE_SCALE, rounding),
    lowestPrice: fixed(raw.lowest, PRICE_SCALE, rounding),
    highestPrice: fixed(raw.highest, PRICE_SCALE, rounding),
    stdDeviation: fixed(raw.stdDeviation, PRICE_SCALE, rounding),
    coefficientOfVariation: fixed(raw.cv, PERCENT_SCALE, rounding),
  };
}

/**
 * RN-PRICE-42: o `methodOverride` do item quando definido (inclusive `MANUAL`); senão o método
 * padrão da pesquisa — `AUTO_CV` vira `MEDIAN` se o CV (como gravado, 4 casas) for maior que o
 * limiar e `MEAN` caso contrário (CV indefinido — 0 ou 1 cotação — não é maior que o limiar).
 */
export function effectiveMethodOf(input: {
  readonly methodOverride: PriceCalculationMethod | null;
  readonly defaultMethod: PriceDefaultMethod;
  readonly coefficientOfVariation: string | null;
  readonly cvThresholdPercent: string;
}): PriceCalculationMethod {
  if (input.methodOverride !== null) return input.methodOverride;
  if (input.defaultMethod !== 'AUTO_CV') return input.defaultMethod;
  if (input.coefficientOfVariation === null) return 'MEAN';
  return new D(input.coefficientOfVariation).greaterThan(input.cvThresholdPercent)
    ? 'MEDIAN'
    : 'MEAN';
}

/** Campos calculados do `PriceItem` (RN-PRICE-41..44). */
export interface PriceItemCalculation extends PriceStatistics {
  readonly effectiveMethod: PriceCalculationMethod;
  /** Decimal(18,4) — já arredondado para `unitPriceDecimals` casas; `null` sem base de cálculo. */
  readonly recommendedUnitPrice: string | null;
  /** Decimal(18,2) — `round(recommendedUnitPrice × quantity, 2)`. */
  readonly totalPrice: string | null;
}

/** O que o cálculo do item lê: o item (quantidade e método) e o snapshot da pesquisa. */
export interface PriceItemInputs {
  readonly quantity: string;
  readonly methodOverride: PriceCalculationMethod | null;
  readonly manualUnitPrice: string | null;
}

/**
 * `PriceItem.recalculate` (fluxo principal 2.1–2.6): estatísticas, método efetivo, preço
 * recomendado e total. `MANUAL` usa o `manualUnitPrice` como informado (RN-PRICE-47: o preço manual
 * não é afetado pelos parâmetros); os demais métodos arredondam o valor estatístico sem arredondar
 * antes (`unitPriceDecimals` casas pelo `roundingMode`). Sem cotação válida o método é gravado e o
 * recomendado fica `null` (RN-PRICE-42).
 */
export function calculatePriceItem(
  item: PriceItemInputs,
  validPrices: readonly string[],
  parameters: Pick<
    PriceResearchParameters,
    'defaultMethod' | 'cvThresholdPercent' | 'unitPriceDecimals' | 'roundingMode'
  >,
): PriceItemCalculation {
  const rounding = ROUNDING[parameters.roundingMode];
  const raw = rawStatistics(validPrices);
  const statistics = priceStatistics(validPrices, parameters.roundingMode);
  const effectiveMethod = effectiveMethodOf({
    methodOverride: item.methodOverride,
    defaultMethod: parameters.defaultMethod,
    coefficientOfVariation: statistics.coefficientOfVariation,
    cvThresholdPercent: parameters.cvThresholdPercent,
  });
  let unit: Dec | null;
  switch (effectiveMethod) {
    case 'MANUAL':
      unit = item.manualUnitPrice === null ? null : new D(item.manualUnitPrice);
      break;
    case 'MEAN':
      unit = raw.mean?.toDecimalPlaces(parameters.unitPriceDecimals, rounding) ?? null;
      break;
    case 'MEDIAN':
      unit = raw.median?.toDecimalPlaces(parameters.unitPriceDecimals, rounding) ?? null;
      break;
    case 'LOWEST':
      unit = raw.lowest?.toDecimalPlaces(parameters.unitPriceDecimals, rounding) ?? null;
      break;
  }
  return {
    ...statistics,
    effectiveMethod,
    recommendedUnitPrice: fixed(unit, PRICE_SCALE, rounding),
    totalPrice:
      unit === null ? null : unit.times(new D(item.quantity)).toFixed(MONEY_SCALE, rounding),
  };
}

/** Valor estimado da pesquisa: soma dos totais calculados; `null` se nenhum item tem total. */
export function totalEstimatedValueOf(
  items: readonly { readonly totalPrice: string | null }[],
): string | null {
  const totals = items.flatMap((item) => (item.totalPrice === null ? [] : [item.totalPrice]));
  if (totals.length === 0) return null;
  return totals.reduce((sum, total) => sum.plus(total), new D(0)).toFixed(MONEY_SCALE);
}

/** Os campos calculados de dois resultados são iguais (recálculo sem mudança não grava a linha). */
export function sameCalculation(
  a: PriceItemCalculation,
  b: { readonly [K in keyof PriceItemCalculation]: PriceItemCalculation[K] | null },
): boolean {
  return (Object.keys(a) as (keyof PriceItemCalculation)[]).every((key) => a[key] === b[key]);
}

// --- Destaque das cotações (US-030 · RN-PRICE-48 · DEC-020) --------------------------------------

/** Limiares de destaque do snapshot (percentuais `numeric(9,4)` como string). */
export type OutlierThresholds = Pick<
  PriceResearchParameters,
  'outlierLowerPercent' | 'outlierUpperPercent'
>;

/**
 * `Quotation.flagOutlier` (RN-PRICE-48): compara o preço com a mediana das DEMAIS cotações válidas
 * do item. Com menos de 2 outras a comparação não é confiável (`NONE`); abaixo de
 * `outlierLowerPercent`% da mediana → `LOW`; acima de `outlierUpperPercent`% → `HIGH`. Só sinaliza:
 * nenhuma cotação é excluída automaticamente (DEC-020). Sem arredondamento intermediário.
 */
export function flagOutlier(
  unitPrice: string,
  otherPrices: readonly string[],
  thresholds: OutlierThresholds,
): OutlierFlag {
  if (otherPrices.length < 2) return 'NONE';
  const median = medianOfSorted(
    otherPrices.map((price) => new D(price)).sort((a, b) => a.comparedTo(b)),
  );
  if (median === null) return 'NONE';
  const price = new D(unitPrice);
  if (price.lessThan(median.times(thresholds.outlierLowerPercent).dividedBy(100))) return 'LOW';
  if (price.greaterThan(median.times(thresholds.outlierUpperPercent).dividedBy(100))) return 'HIGH';
  return 'NONE';
}

/**
 * RN-PRICE-48 para todas as cotações válidas de um item: cada uma contra as demais (O(n²) — o teto
 * prático é de dezenas de fontes por item). Devolve o destaque por id da cotação.
 */
export function outlierFlagsOf(
  quotations: readonly { readonly id: string; readonly unitPrice: string }[],
  thresholds: OutlierThresholds,
): Map<string, OutlierFlag> {
  return new Map(
    quotations.map((quotation, index) => [
      quotation.id,
      flagOutlier(
        quotation.unitPrice,
        quotations.filter((_, other) => other !== index).map((other) => other.unitPrice),
        thresholds,
      ),
    ]),
  );
}
