import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { DecimalScaleError, fromDbDecimal, roundTo, toDbDecimal } from './decimal.js';

describe('toDbDecimal (DEC-003 · RN-FND-41 · V-01)', () => {
  it('grava com a escala exata da coluna', () => {
    expect(toDbDecimal('10.5', 'money')).toBe('10.50');
    expect(toDbDecimal(new Decimal('3'), 'quantity')).toBe('3.0000');
    expect(toDbDecimal('0.1234', 'unitPrice')).toBe('0.1234');
    expect(toDbDecimal('-99999.9999', 'percentage')).toBe('-99999.9999');
    expect(toDbDecimal('9999999999999999.99', 'money')).toBe('9999999999999999.99');
    expect(toDbDecimal('0', 'money')).toBe('0.00');
  });

  it('aceita o Decimal do Prisma (objeto com toFixed)', () => {
    expect(toDbDecimal({ toFixed: () => '12.3' }, 'money')).toBe('12.30');
  });

  it('[Validação] rejeita 10.999 em Decimal(18,2) sem arredondar', () => {
    const attempt = () => toDbDecimal('10.999', 'money');
    expect(attempt).toThrow(DecimalScaleError);
    expect(attempt).toThrow(/money \(scale\)/);
  });

  it('rejeita valor acima da precisão da coluna', () => {
    expect(() => toDbDecimal('10000000000000000', 'money')).toThrow(/precision/);
    expect(() => toDbDecimal('100000', 'percentage')).toThrow(/precision/);
  });

  it('rejeita valor não finito', () => {
    expect(() => toDbDecimal(new Decimal(Number.NaN), 'money')).toThrow(/not-finite/);
    expect(() => toDbDecimal(new Decimal(Infinity), 'money')).toThrow(/not-finite/);
  });
});

describe('fromDbDecimal e roundTo', () => {
  it('lê a coluna como decimal.js, sem perder casas', () => {
    const value = fromDbDecimal('1234567890123456.78');
    expect(value).toBeInstanceOf(Decimal);
    expect(value.toFixed()).toBe('1234567890123456.78');
    expect(
      fromDbDecimal({ toFixed: () => '0.30' })
        .plus('0.1')
        .equals('0.4'),
    ).toBe(true);
  });

  it('normaliza totais com ROUND_HALF_UP na escala da coluna', () => {
    expect(roundTo('2.345', 'money').toFixed()).toBe('2.35');
    expect(roundTo('-2.345', 'money').toFixed()).toBe('-2.35');
    expect(roundTo('10.999', 'money').toFixed(2)).toBe('11.00');
    expect(roundTo('1.23456', 'percentage').toFixed()).toBe('1.2346');
  });
});
