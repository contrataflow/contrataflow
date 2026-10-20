import { describe, expect, it } from 'vitest';

import {
  canonicalQuantity,
  evaluateTermCompleteness,
  TERM_BLOCKING_CODES,
  TERM_COMPLETENESS_MESSAGES,
  TERM_VIOLATION_CODES,
  TERM_WARNING_CODES,
} from './term-completeness.js';
import type { TermCompletenessInput } from './term-completeness.js';
import type { DraftSection } from '../document/document.js';
import { richTextFromPlainText } from '../document/rich-text.js';

const SECTION_BASE = {
  revision: 1,
  updatedAt: '2026-10-20T15:00:00.000Z',
  updatedById: '0192f039-0000-7000-8000-0000000000a1',
};
const filled = (text: string): DraftSection => ({
  ...SECTION_BASE,
  state: 'FILLED',
  content: richTextFromPlainText(text),
  justification: null,
});

const complete: TermCompletenessInput = {
  estimatedTotalValue: '125000.00',
  estimatedValueSource: 'PRICE_RESEARCH',
  selectionCriterionId: '0192f039-0000-7000-8000-0000000000c1',
  awardType: 'BY_ITEM',
  productWarrantyMonths: 12,
  contractGuaranteePercent: null,
  estimatedValueSection: undefined,
  items: [
    { id: 'tr-1', processItemId: 'p-1', quantity: '100.0000' },
    { id: 'tr-3', processItemId: 'p-3', quantity: '40.0000' },
  ],
  etpItems: [
    { processItemId: 'p-1', sequence: 1, quantity: '100.0000' },
    { processItemId: 'p-3', sequence: 3, quantity: '40.0000' },
  ],
};

const codes = (input: TermCompletenessInput) =>
  evaluateTermCompleteness(input).map(
    (item) => `${item.severity}:${item.code}:${item.field ?? item.sectionKey ?? ''}`,
  );

describe('evaluateTermCompleteness — RN-TR-35/36', () => {
  it('TR completo e coerente com o ETP: nenhuma pendência', () => {
    expect(evaluateTermCompleteness(complete)).toEqual([]);
  });

  it('catálogo TR_*: 5 bloqueantes e 2 avisos, todos com o prefixo TR_', () => {
    expect(TERM_VIOLATION_CODES).toEqual([...TERM_BLOCKING_CODES, ...TERM_WARNING_CODES]);
    expect(TERM_VIOLATION_CODES.every((code) => code.startsWith('TR_'))).toBe(true);
    expect(TERM_BLOCKING_CODES).toHaveLength(5);
    expect(TERM_WARNING_CODES).toHaveLength(2);
  });

  it('RN-TR-35: sem valor, sem item com quantidade, sem critério e sem adjudicação', () => {
    const violations = evaluateTermCompleteness({
      ...complete,
      estimatedTotalValue: null,
      estimatedValueSource: null,
      selectionCriterionId: null,
      awardType: null,
      items: [
        { id: 'tr-1', processItemId: 'p-1', quantity: '0.0000' },
        { id: 'tr-2', processItemId: 'p-2', quantity: null },
      ],
      etpItems: null,
    });
    expect(violations.map((item) => [item.severity, item.code, item.field])).toEqual([
      ['BLOCKING', 'TR_ESTIMATED_VALUE_REQUIRED', 'estimatedTotalValue'],
      ['BLOCKING', 'TR_ITEMS_REQUIRED', 'items'],
      ['BLOCKING', 'TR_SELECTION_CRITERION_REQUIRED', 'selectionCriterionId'],
      ['BLOCKING', 'TR_AWARD_TYPE_REQUIRED', 'awardType'],
    ]);
    expect(violations[0]).toEqual({
      code: 'TR_ESTIMATED_VALUE_REQUIRED',
      severity: 'BLOCKING',
      message: TERM_COMPLETENESS_MESSAGES.estimatedValueRequired,
      ruleId: null,
      sectionKey: null,
      field: 'estimatedTotalValue',
      itemId: null,
      params: {},
    });
  });

  it('TR sem nenhum item: TR_ITEMS_REQUIRED', () => {
    expect(codes({ ...complete, items: [], etpItems: null })).toEqual([
      'BLOCKING:TR_ITEMS_REQUIRED:items',
    ]);
  });

  describe('precedência do valor estimado (RN-TR-08)', () => {
    it('sem valor: só TR_ESTIMATED_VALUE_REQUIRED, mesmo com origem MANUAL', () => {
      expect(
        codes({ ...complete, estimatedTotalValue: ' ', estimatedValueSource: 'MANUAL' }),
      ).toEqual(['BLOCKING:TR_ESTIMATED_VALUE_REQUIRED:estimatedTotalValue']);
    });

    it('valor MANUAL sem a seção ESTIMATED_VALUE: exige a justificativa na seção', () => {
      const [violation] = evaluateTermCompleteness({
        ...complete,
        estimatedValueSource: 'MANUAL',
      });
      expect(violation).toMatchObject({
        code: 'TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED',
        severity: 'BLOCKING',
        sectionKey: 'ESTIMATED_VALUE',
        field: null,
      });
    });

    it('valor MANUAL com a seção vazia ou "não se aplica" sem justificativa: pendente', () => {
      for (const section of [
        filled('   '),
        { ...SECTION_BASE, state: 'NOT_APPLICABLE' as const, content: null, justification: 'x' },
        { ...SECTION_BASE, state: 'EMPTY' as const, content: null, justification: null },
      ]) {
        expect(
          codes({ ...complete, estimatedValueSource: 'MANUAL', estimatedValueSection: section }),
        ).toEqual(['BLOCKING:TR_ESTIMATED_VALUE_JUSTIFICATION_REQUIRED:ESTIMATED_VALUE']);
      }
    });

    it('valor MANUAL com a seção preenchida ou "não se aplica" justificado: sem pendência', () => {
      expect(
        codes({
          ...complete,
          estimatedValueSource: 'MANUAL',
          estimatedValueSection: filled('Valor estimado a partir de contratações anteriores.'),
        }),
      ).toEqual([]);
      expect(
        codes({
          ...complete,
          estimatedValueSource: 'MANUAL',
          estimatedValueSection: {
            ...SECTION_BASE,
            state: 'NOT_APPLICABLE',
            content: null,
            justification: 'Valor definido em ata de registro de preços vigente.',
          },
        }),
      ).toEqual([]);
    });

    it('valor vindo da pesquisa ou do ETP não exige a seção', () => {
      expect(codes({ ...complete, estimatedValueSource: 'ETP' })).toEqual([]);
    });
  });

  describe('TR_ITEM_QUANTITY_DIVERGENT (RN-TR-36)', () => {
    it('item 3 com 50 no TR e 40 no ETP: um aviso para o item, com as quantidades', () => {
      const violations = evaluateTermCompleteness({
        ...complete,
        items: [
          { id: 'tr-1', processItemId: 'p-1', quantity: '100.0000' },
          { id: 'tr-3', processItemId: 'p-3', quantity: '50.0000' },
        ],
      });
      expect(violations).toEqual([
        {
          code: 'TR_ITEM_QUANTITY_DIVERGENT',
          severity: 'WARNING',
          message: 'A quantidade do item 3 no TR (50) diverge da quantidade no ETP (40).',
          ruleId: null,
          sectionKey: null,
          field: 'items',
          itemId: 'tr-3',
          params: { etpQuantity: '40', trQuantity: '50', processItemId: 'p-3', sequence: 3 },
        },
      ]);
    });

    it('um aviso por item divergente; itens sem par no ETP não são comparados', () => {
      const violations = evaluateTermCompleteness({
        ...complete,
        items: [
          { id: 'tr-1', processItemId: 'p-1', quantity: '2.5000' },
          { id: 'tr-3', processItemId: 'p-3', quantity: '41' },
          { id: 'tr-9', processItemId: 'p-9', quantity: '7' },
        ],
      });
      expect(violations.map((item) => [item.itemId, item.params])).toEqual([
        ['tr-1', { etpQuantity: '100', trQuantity: '2.5', processItemId: 'p-1', sequence: 1 }],
        ['tr-3', { etpQuantity: '40', trQuantity: '41', processItemId: 'p-3', sequence: 3 }],
      ]);
      expect(violations[0]?.message).toContain('(2,5)');
    });

    it('mesma quantidade em escalas diferentes não diverge ("40" × "40.0000")', () => {
      expect(
        codes({
          ...complete,
          items: [{ id: 'tr-3', processItemId: 'p-3', quantity: '40' }],
        }),
      ).toEqual([]);
    });

    it('sem ETP elegível (null): nenhuma comparação', () => {
      expect(
        codes({
          ...complete,
          items: [{ id: 'tr-3', processItemId: 'p-3', quantity: '999' }],
          etpItems: null,
        }),
      ).toEqual([]);
    });

    it('quantidade ilegível de um dos lados não gera aviso', () => {
      expect(
        codes({
          ...complete,
          etpItems: [{ processItemId: 'p-3', sequence: null, quantity: null }],
        }),
      ).toEqual([]);
      expect(TERM_COMPLETENESS_MESSAGES.itemQuantityDivergent(null, '1', '2')).toBe(
        'A quantidade do item no TR (1) diverge da quantidade no ETP (2).',
      );
    });
  });

  describe('TR_GUARANTEE_NOT_DEFINED (RN-TR-36)', () => {
    it('garantia do produto e contratual nulas: aviso', () => {
      expect(
        codes({ ...complete, productWarrantyMonths: null, contractGuaranteePercent: null }),
      ).toEqual(['WARNING:TR_GUARANTEE_NOT_DEFINED:productWarrantyMonths']);
    });

    it('basta uma das garantias', () => {
      expect(
        codes({ ...complete, productWarrantyMonths: null, contractGuaranteePercent: '5' }),
      ).toEqual([]);
      expect(codes({ ...complete, productWarrantyMonths: 0 })).toEqual([]);
    });
  });

  it('bloqueantes antes dos avisos', () => {
    expect(
      codes({
        ...complete,
        awardType: null,
        productWarrantyMonths: null,
        items: [{ id: 'tr-3', processItemId: 'p-3', quantity: '50' }],
      }),
    ).toEqual([
      'BLOCKING:TR_AWARD_TYPE_REQUIRED:awardType',
      'WARNING:TR_ITEM_QUANTITY_DIVERGENT:items',
      'WARNING:TR_GUARANTEE_NOT_DEFINED:productWarrantyMonths',
    ]);
  });
});

describe('canonicalQuantity', () => {
  it('normaliza zeros e recusa o que não é decimal não negativo', () => {
    expect(canonicalQuantity('50.0000')).toBe('50');
    expect(canonicalQuantity('007.250')).toBe('7.25');
    expect(canonicalQuantity('0.0000')).toBe('0');
    expect(canonicalQuantity(' 12 ')).toBe('12');
    expect(canonicalQuantity(null)).toBeNull();
    expect(canonicalQuantity('-1')).toBeNull();
    expect(canonicalQuantity('abc')).toBeNull();
  });

  it('fração adversarial (muitos zeros antes de um dígito) roda em tempo linear', () => {
    const zeros = '0'.repeat(100_000);
    const startedAt = performance.now();
    expect(canonicalQuantity(`1.${zeros}1`)).toBe(`1.${zeros}1`);
    expect(canonicalQuantity(`1.${zeros}`)).toBe('1');
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
