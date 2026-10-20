import { describe, expect, it } from 'vitest';

import { costOf, fromMicros, toMicros } from './ai-pricing.js';
import { AI_PRICING_TABLE } from './pricing-table.js';

const TABLE = {
  version: '2026-10-16.9',
  models: {
    'modelo-a': { inputPerMillionUsd: '3', outputPerMillionUsd: '15' },
    'modelo-b': { inputPerMillionUsd: '0.25', outputPerMillionUsd: '1.25' },
  },
};

describe('custo por geração (RN-AI-09)', () => {
  it('input × preço de entrada + output × preço de saída, em numeric(12,6)', () => {
    expect(costOf(TABLE, 'modelo-a', { inputTokens: 12_000, outputTokens: 3_000 })).toEqual({
      costUsd: '0.081000',
      pricingVersion: '2026-10-16.9',
    });
    expect(costOf(TABLE, 'modelo-b', { inputTokens: 1, outputTokens: 1 }).costUsd).toBe('0.000002');
    expect(costOf(TABLE, 'modelo-a', { inputTokens: 0, outputTokens: 0 }).costUsd).toBe('0.000000');
  });

  it('modelo sem preço → costUsd null (o chamador registra ai.pricing_missing)', () => {
    expect(costOf(TABLE, 'desconhecido', { inputTokens: 10, outputTokens: 10 })).toEqual({
      costUsd: null,
      pricingVersion: '2026-10-16.9',
    });
    expect(costOf(TABLE, 'toString', { inputTokens: 1, outputTokens: 1 }).costUsd).toBeNull();
  });

  it('aritmética inteira em micro-dólares (sem ponto flutuante em dinheiro)', () => {
    expect(toMicros('3.5')).toBe(3_500_000n);
    expect(toMicros('0.000001')).toBe(1n);
    expect(fromMicros(1_234_567n)).toBe('1.234567');
    expect(() => toMicros('1,5')).toThrow(/Preço inválido/);
    expect(() => toMicros('0.0000001')).toThrow(/Preço inválido/);
  });

  it('a tabela da plataforma é versionada e cobre os modelos do provedor de teste (custo zero)', () => {
    expect(AI_PRICING_TABLE.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    for (const model of ['fake-draft-1', 'fake-section-1']) {
      expect(
        costOf(AI_PRICING_TABLE, model, { inputTokens: 1_000, outputTokens: 1_000 }).costUsd,
      ).toBe('0.000000');
    }
  });
});
