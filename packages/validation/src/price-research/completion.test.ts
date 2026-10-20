import { describe, expect, it } from 'vitest';

import {
  belowMinimumJustificationIssue,
  completePriceResearchSchema,
  PRICE_COMPLETION_MESSAGES,
  priceCompletionMessage,
  priceItemCompletionIssue,
} from './completion.js';

describe('priceItemCompletionIssue (RN-PRICE-58)', () => {
  const complete = {
    recommendedUnitPrice: '100.0000',
    validQuotationsCount: 3,
    belowMinimumJustification: null,
  };

  it('item com preço e cotações suficientes está completo', () => {
    expect(priceItemCompletionIssue(complete, 3)).toBeNull();
  });

  it('sem preço ou sem cotação válida → PRICE_ITEM_WITHOUT_PRICE', () => {
    expect(priceItemCompletionIssue({ ...complete, recommendedUnitPrice: null }, 3)).toBe(
      'PRICE_ITEM_WITHOUT_PRICE',
    );
    expect(
      priceItemCompletionIssue(
        { ...complete, validQuotationsCount: 0, belowMinimumJustification: 'x'.repeat(30) },
        3,
      ),
    ).toBe('PRICE_ITEM_WITHOUT_PRICE');
  });

  it('abaixo do mínimo exige justificativa', () => {
    const below = { ...complete, validQuotationsCount: 2 };
    expect(priceItemCompletionIssue(below, 3)).toBe('PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED');
    expect(
      priceItemCompletionIssue({ ...below, belowMinimumJustification: 'x'.repeat(20) }, 3),
    ).toBeNull();
  });
});

describe('mensagens e contratos da conclusão', () => {
  it('mensagem por código, com o rótulo do item', () => {
    const facts = { recommendedUnitPrice: null, validQuotationsCount: 0, sequence: 2 };
    expect(
      priceCompletionMessage('PRICE_ITEM_WITHOUT_PRICE', {
        ...facts,
        belowMinimumJustification: null,
      }),
    ).toBe('O item "Item 2" não tem preço calculado. Registre cotações ou um valor manual.');
    expect(
      priceCompletionMessage('PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED', {
        ...facts,
        recommendedUnitPrice: '1',
        validQuotationsCount: 1,
        belowMinimumJustification: null,
      }),
    ).toBe('O item "Item 2" tem menos cotações que o mínimo exigido. Informe a justificativa.');
    expect(PRICE_COMPLETION_MESSAGES.withAlerts(1)).toBe(
      'Esta pesquisa será concluída com 1 item com alerta.',
    );
    expect(PRICE_COMPLETION_MESSAGES.withAlerts(3)).toBe(
      'Esta pesquisa será concluída com 3 itens com alerta.',
    );
  });

  it('justificativa: vazia é válida (apaga); curta é recusada', () => {
    expect(belowMinimumJustificationIssue(null)).toBeNull();
    expect(belowMinimumJustificationIssue('   ')).toBeNull();
    expect(belowMinimumJustificationIssue('curta')).toBe(
      PRICE_COMPLETION_MESSAGES.justificationTooShort,
    );
    expect(belowMinimumJustificationIssue('Mercado restrito na região.')).toBeNull();
  });

  it('PRS-23 aceita só o corpo vazio', () => {
    expect(completePriceResearchSchema.safeParse({}).success).toBe(true);
    expect(completePriceResearchSchema.safeParse({ force: true }).success).toBe(false);
  });
});
