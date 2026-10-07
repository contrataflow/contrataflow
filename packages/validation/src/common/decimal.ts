import { z } from 'zod';

export interface DecimalStringOptions {
  /** Total de dígitos (precisão do `Decimal(p, s)` do banco). */
  readonly precision: number;
  /** Dígitos após o separador decimal. */
  readonly scale: number;
  /** Aceita valores negativos (padrão: não). */
  readonly allowNegative?: boolean;
}

/**
 * Decimal trafegado como string com ponto, ex.: `"12345.67"` (DEC-003). Nunca `number`.
 * Os cálculos usam `decimal.js` nas camadas de domínio.
 */
export function decimalString({ precision, scale, allowNegative = false }: DecimalStringOptions) {
  if (!Number.isInteger(precision) || !Number.isInteger(scale) || scale < 0 || precision <= scale) {
    throw new RangeError(`Decimal inválido: precisão ${precision}, escala ${scale}.`);
  }
  const integerDigits = precision - scale;
  const sign = allowNegative ? '-?' : '';
  const fraction = scale > 0 ? String.raw`(?:\.\d{1,${scale}})?` : '';
  const pattern = new RegExp(String.raw`^${sign}(?:0|[1-9]\d{0,${integerDigits - 1}})${fraction}$`);
  const range =
    scale > 0
      ? `até ${integerDigits} dígitos inteiros e ${scale} casas decimais`
      : `até ${integerDigits} dígitos`;
  return z.string().regex(pattern, {
    error: `Informe um número decimal com ${range}, usando ponto como separador (ex.: "1234.5").`,
  });
}

/** Valor monetário `Decimal(18,2)`. */
export const moneySchema = decimalString({ precision: 18, scale: 2 });
/** Preço unitário `Decimal(18,4)`. */
export const unitPriceSchema = decimalString({ precision: 18, scale: 4 });
/** Quantidade `Decimal(18,4)`. */
export const quantitySchema = decimalString({ precision: 18, scale: 4 });
/** Percentual `Decimal(9,4)`. */
export const percentageSchema = decimalString({ precision: 9, scale: 4 });
