import { describe, expect, it } from 'vitest';

import { acceptsDerivedEstimatedValue } from './derived-estimated-value.js';

describe('acceptsDerivedEstimatedValue (DEC-032)', () => {
  it('sem origem, qualquer documento grava o valor', () => {
    expect(acceptsDerivedEstimatedValue(null, 'PRICE_RESEARCH')).toBe(true);
  });

  it.each(['MANUAL', 'DFD', 'ETP', 'PRICE_RESEARCH'] as const)(
    'a pesquisa concluída substitui a origem %s',
    (current) => {
      expect(acceptsDerivedEstimatedValue(current, 'PRICE_RESEARCH')).toBe(true);
    },
  );

  it('o TR aprovado tem precedência sobre a pesquisa de preços', () => {
    expect(acceptsDerivedEstimatedValue('TERM', 'PRICE_RESEARCH')).toBe(false);
    expect(acceptsDerivedEstimatedValue('PRICE_RESEARCH', 'TERM')).toBe(true);
  });

  it('fonte de menor precedência não substitui a maior', () => {
    expect(acceptsDerivedEstimatedValue('PRICE_RESEARCH', 'ETP')).toBe(false);
    expect(acceptsDerivedEstimatedValue('ETP', 'DFD')).toBe(false);
  });
});
