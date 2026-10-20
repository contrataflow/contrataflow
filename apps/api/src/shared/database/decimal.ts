import { Decimal } from 'decimal.js';

/**
 * Escalas de DEC-003 (RN-FND-41): dinheiro `Decimal(18,2)`, preço unitário e quantidade
 * `Decimal(18,4)`, percentual `Decimal(9,4)`. Todo cálculo usa `decimal.js`, nunca `number`.
 */
export const DECIMAL_COLUMNS = Object.freeze({
  money: { precision: 18, scale: 2 },
  unitPrice: { precision: 18, scale: 4 },
  quantity: { precision: 18, scale: 4 },
  percentage: { precision: 9, scale: 4 },
} as const);

export type DecimalColumn = keyof typeof DECIMAL_COLUMNS;

/** Valor aceito pelos conversores: `decimal.js`, string decimal ou o `Decimal` do Prisma. */
export type DecimalInput = Decimal | string | { toFixed(): string };

/** Arredondamento padrão de totais (DEC-003; alternativa ABNT NBR 5891 em PEND-05). */
export const ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * Valor fora da escala/precisão da coluna (V-01). Erro de programação: o caso de uso deve
 * arredondar explicitamente (`roundTo`) antes de persistir — o mapeador nunca arredonda calado.
 */
export class DecimalScaleError extends Error {
  constructor(
    readonly column: DecimalColumn,
    readonly reason: 'not-finite' | 'scale' | 'precision',
  ) {
    super(`Valor decimal inválido para ${column} (${reason}) — DEC-003.`);
    this.name = 'DecimalScaleError';
  }
}

function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  return new Decimal(typeof value === 'string' ? value : value.toFixed());
}

/**
 * Converte para o formato gravado na coluna (`string` com a escala exata, aceito pelo Prisma).
 * Rejeita — sem arredondar — valor não finito, com mais casas que a escala ou acima da precisão.
 */
export function toDbDecimal(value: DecimalInput, column: DecimalColumn): string {
  const { precision, scale } = DECIMAL_COLUMNS[column];
  const decimal = toDecimal(value);
  if (!decimal.isFinite()) throw new DecimalScaleError(column, 'not-finite');
  if (decimal.decimalPlaces() > scale) throw new DecimalScaleError(column, 'scale');
  const integerDigits = decimal.abs().truncated().toFixed().replace(/^0$/, '').length;
  if (integerDigits > precision - scale) throw new DecimalScaleError(column, 'precision');
  return decimal.toFixed(scale);
}

/** Lê uma coluna decimal (o `Decimal` do Prisma ou string) como `decimal.js`, nunca `number`. */
export function fromDbDecimal(value: DecimalInput): Decimal {
  return toDecimal(value);
}

/** Arredonda para a escala da coluna com `ROUND_HALF_UP` (normalização explícita de totais). */
export function roundTo(value: DecimalInput, column: DecimalColumn): Decimal {
  return toDecimal(value).toDecimalPlaces(DECIMAL_COLUMNS[column].scale, ROUNDING);
}
