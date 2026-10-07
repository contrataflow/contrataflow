import { describe, expect, it } from 'vitest';

import {
  decimalString,
  moneySchema,
  percentageSchema,
  quantitySchema,
  unitPriceSchema,
} from './decimal.js';

describe('decimalString', () => {
  it('aceita valores dentro da precisão e da escala', () => {
    expect(moneySchema.safeParse('12345.67').success).toBe(true);
    expect(moneySchema.safeParse('0').success).toBe(true);
    expect(moneySchema.safeParse('0.5').success).toBe(true);
    expect(moneySchema.safeParse('9999999999999999.99').success).toBe(true);
    expect(unitPriceSchema.safeParse('10.1234').success).toBe(true);
    expect(quantitySchema.safeParse('3').success).toBe(true);
    expect(percentageSchema.safeParse('99999.9999').success).toBe(true);
  });

  it('rejeita number, vírgula, excesso de casas, zeros à esquerda e negativos', () => {
    expect(moneySchema.safeParse(12.5).success).toBe(false);
    expect(moneySchema.safeParse('12,50').success).toBe(false);
    expect(moneySchema.safeParse('12.505').success).toBe(false);
    expect(moneySchema.safeParse('012.50').success).toBe(false);
    expect(moneySchema.safeParse('-1.00').success).toBe(false);
    expect(moneySchema.safeParse('10000000000000000').success).toBe(false);
    expect(moneySchema.safeParse('1.').success).toBe(false);
    expect(percentageSchema.safeParse('100000').success).toBe(false);
  });

  it('aceita negativos somente quando permitido', () => {
    const schema = decimalString({ precision: 10, scale: 2, allowNegative: true });
    expect(schema.safeParse('-15.20').success).toBe(true);
  });

  it('aceita inteiros quando a escala é zero', () => {
    const schema = decimalString({ precision: 3, scale: 0 });
    expect(schema.safeParse('999').success).toBe(true);
    expect(schema.safeParse('1.5').success).toBe(false);
    expect(schema.safeParse('1000').success).toBe(false);
  });

  it('explica o formato esperado em pt-BR', () => {
    const result = moneySchema.safeParse('abc');
    expect(result.error?.issues[0]?.message).toBe(
      'Informe um número decimal com até 16 dígitos inteiros e 2 casas decimais, usando ponto como separador (ex.: "1234.5").',
    );
    const integer = decimalString({ precision: 3, scale: 0 }).safeParse('x');
    expect(integer.error?.issues[0]?.message).toContain('até 3 dígitos,');
  });

  it('rejeita configurações inválidas', () => {
    expect(() => decimalString({ precision: 2, scale: 2 })).toThrow(RangeError);
    expect(() => decimalString({ precision: 5, scale: -1 })).toThrow(RangeError);
    expect(() => decimalString({ precision: 5.5, scale: 1 })).toThrow(RangeError);
    expect(() => decimalString({ precision: 5, scale: 1.5 })).toThrow(RangeError);
  });
});
