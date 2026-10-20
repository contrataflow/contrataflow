import { describe, expect, it } from 'vitest';

import { priceItem, priceResearchDto } from '@test/support/price-research-fixtures';

import {
  completedToast,
  completionPreview,
  justificationIssue,
  needsBelowMinimumJustification,
  pendingFromViolations,
} from './price-completion-model';

const priced = (n: number, extra: Parameters<typeof priceItem>[1] = {}) =>
  priceItem(n, {
    validQuotationsCount: 3,
    recommendedUnitPrice: '100.0000',
    totalPrice: '1000.00',
    alerts: [],
    ...extra,
  });

describe('completionPreview (RN-PRICE-58 · FA-03)', () => {
  it('itens completos: sem pendências; conta os itens com alerta', () => {
    const preview = completionPreview([priced(1), priced(2, { alerts: [{ code: 'HIGH_CV' }] })], 3);
    expect(preview).toEqual({ pending: [], itemsWithAlerts: 1 });
  });

  it('lista as pendências na ordem dos itens, com a mensagem da API', () => {
    const preview = completionPreview(
      [
        priced(2, { validQuotationsCount: 1, alerts: [{ code: 'BELOW_MINIMUM_QUOTES' }] }),
        priceItem(1),
      ],
      3,
    );
    expect(preview.pending).toEqual([
      {
        itemId: priceItem(1).id,
        sequence: 1,
        code: 'PRICE_ITEM_WITHOUT_PRICE',
        message: 'O item "Item 1" não tem preço calculado. Registre cotações ou um valor manual.',
      },
      expect.objectContaining({ sequence: 2, code: 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED' }),
    ]);
    const justified = completionPreview(
      [
        priced(2, {
          validQuotationsCount: 1,
          belowMinimumJustification: 'Mercado restrito na região.',
        }),
      ],
      3,
    );
    expect(justified.pending).toEqual([]);
  });
});

describe('pendingFromViolations', () => {
  it('só as violações de item da pesquisa, com o nº do item', () => {
    const item = priced(2);
    const pending = pendingFromViolations(
      [
        {
          code: 'PRICE_ITEM_WITHOUT_PRICE',
          severity: 'BLOCKING',
          message: 'm',
          ruleId: 'RN-PRICE-58',
          sectionKey: null,
          field: null,
          itemId: item.id,
          params: {},
        },
        {
          code: 'SECTION_REQUIRED',
          severity: 'BLOCKING',
          message: 's',
          ruleId: null,
          sectionKey: 'CONCLUSION',
          field: null,
          itemId: null,
          params: {},
        },
      ],
      [item],
    );
    expect(pending).toEqual([
      { itemId: item.id, sequence: 2, code: 'PRICE_ITEM_WITHOUT_PRICE', message: 'm' },
    ]);
  });
});

describe('textos e regras do campo de justificativa', () => {
  it('toast com o valor atualizado ou "Sigiloso"', () => {
    expect(completedToast(priceResearchDto({ totalEstimatedValue: '9000.00' }))).toMatch(
      /^Pesquisa de preços concluída — valor estimado atualizado para R\$\s9\.000,00$/,
    );
    expect(
      completedToast(
        priceResearchDto({ totalEstimatedValue: null, totalEstimatedValueMasked: true }),
      ),
    ).toBe('Pesquisa de preços concluída — valor estimado atualizado para Sigiloso');
  });

  it('campo aparece abaixo do mínimo com alguma válida ou quando já justificado', () => {
    expect(needsBelowMinimumJustification(priced(1, { validQuotationsCount: 1 }), 3)).toBe(true);
    expect(needsBelowMinimumJustification(priced(1), 3)).toBe(false);
    expect(needsBelowMinimumJustification(priceItem(1), 3)).toBe(false);
    expect(
      needsBelowMinimumJustification(priced(1, { belowMinimumJustification: 'x'.repeat(20) }), 3),
    ).toBe(true);
    expect(justificationIssue('curta')).toMatch(/20 caracteres/);
    expect(justificationIssue('')).toBeNull();
  });
});
