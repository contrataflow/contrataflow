import { describe, expect, it } from 'vitest';

import {
  completenessPercent,
  termCompleteness,
  termJustificationProblem,
  termSectionAllowsNotApplicable,
} from './term-sections.js';
import {
  isTermMoney,
  termCreateSchema,
  termDocumentTitle,
  termDeadlineIssue,
  termPatchSchema,
  TERM_CONDITION_MESSAGES,
  TERM_MESSAGES,
} from './term.js';
import { itemRichTextIssue } from '../document/document-items.js';
import type { DraftContent } from '../document/document.js';
import { richTextFromPlainText } from '../document/rich-text.js';

const NOW = '2026-10-19T12:00:00.000Z';

function section(
  state: 'EMPTY' | 'FILLED' | 'NOT_APPLICABLE',
  text?: string,
  justification?: string,
) {
  return {
    state,
    content: text === undefined ? null : richTextFromPlainText(text),
    justification: justification ?? null,
    revision: 1,
    updatedAt: NOW,
    updatedById: null,
  };
}

describe('termDocumentTitle', () => {
  it('usa "Termo de Referência — {título do processo}"', () => {
    expect(termDocumentTitle('Aquisição de computadores')).toBe(
      'Termo de Referência — Aquisição de computadores',
    );
    expect(termDocumentTitle('  ')).toBe('Termo de Referência');
  });

  it('corta em 250 caracteres', () => {
    const title = termDocumentTitle('x'.repeat(400));
    expect(Array.from(title)).toHaveLength(250);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('termCreateSchema (V-01/V-02)', () => {
  it('aceita corpo vazio e título de 5 a 250', () => {
    expect(termCreateSchema.parse({})).toEqual({});
    expect(termCreateSchema.parse({ title: '  TR de teste ' })).toEqual({ title: 'TR de teste' });
  });

  it('recusa título curto, longo e campos desconhecidos', () => {
    expect(termCreateSchema.safeParse({ title: 'TR' }).success).toBe(false);
    expect(termCreateSchema.safeParse({ title: 'x'.repeat(251) }).success).toBe(false);
    expect(termCreateSchema.safeParse({ importFromEtp: true }).success).toBe(false);
    expect(termCreateSchema.safeParse({ templateId: 'abc' }).success).toBe(false);
  });
});

describe('termPatchSchema (RN-TR-14 · V-11)', () => {
  it('objeto de 10 a 2.000 caracteres', () => {
    expect(termPatchSchema.safeParse({ objectDefinition: 'curto' }).success).toBe(false);
    expect(termPatchSchema.safeParse({ objectDefinition: 'x'.repeat(2001) }).success).toBe(false);
    expect(termPatchSchema.parse({ objectDefinition: ' Aquisição de notebooks ' })).toEqual({
      objectDefinition: 'Aquisição de notebooks',
    });
  });

  it('valor ≥ 0 com até 2 casas, como string', () => {
    expect(termPatchSchema.safeParse({ estimatedTotalValue: '100000.00' }).success).toBe(true);
    for (const value of ['-1', '10.123', '1,50', 'abc']) {
      const result = termPatchSchema.safeParse({ estimatedTotalValue: value });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(TERM_MESSAGES.valueInvalid);
    }
    expect(isTermMoney(' 98000.5 ')).toBe(true);
    expect(isTermMoney('98000.555')).toBe(false);
  });
});

describe('"Não se aplica" (RN-TR-12 · V-07/V-08)', () => {
  it('só fora das seções REQUIRED', () => {
    expect(termSectionAllowsNotApplicable('REQUIRED')).toBe(false);
    expect(termSectionAllowsNotApplicable('REQUIRED_OR_JUSTIFY')).toBe(true);
    expect(termSectionAllowsNotApplicable('OPTIONAL')).toBe(true);
  });

  it('justificativa de 20 a 2.000 caracteres', () => {
    expect(termJustificationProblem('Serviço remoto')).toBe(TERM_MESSAGES.justificationTooShort);
    expect(termJustificationProblem(null)).toBe(TERM_MESSAGES.justificationTooShort);
    expect(termJustificationProblem('O serviço é prestado de forma remota.')).toBeNull();
    expect(termJustificationProblem('x'.repeat(2001))).toMatch(/no máximo/);
  });
});

describe('termCompleteness (RN-TR-13)', () => {
  const rules = [
    { key: 'OBJECT', order: 1, requirement: 'REQUIRED' as const },
    { key: 'DELIVERY', order: 2, requirement: 'REQUIRED_OR_JUSTIFY' as const },
    { key: 'NOTES', order: 3, requirement: 'OPTIONAL' as const },
    { key: 'SANCTIONS', order: 4, requirement: 'REQUIRED' as const, minChars: 20 },
  ];

  it('conta só as exigidas; "não se aplica" justificada resolve REQUIRED_OR_JUSTIFY', () => {
    const draft: DraftContent = {
      sections: {
        OBJECT: section('FILLED', 'Aquisição de notebooks'),
        DELIVERY: section('NOT_APPLICABLE', undefined, 'O serviço é prestado de forma remota.'),
        SANCTIONS: section('FILLED', 'curto'),
      },
    } as unknown as DraftContent;
    expect(termCompleteness(rules, draft)).toEqual({
      required: 3,
      satisfied: 2,
      percent: 66,
      sections: [
        { key: 'OBJECT', complete: true },
        { key: 'DELIVERY', complete: true },
        { key: 'SANCTIONS', complete: false },
      ],
    });
  });

  it('REQUIRED marcada "não se aplica" e seções ausentes não contam como satisfeitas', () => {
    const draft = {
      sections: { OBJECT: section('NOT_APPLICABLE', undefined, 'x'.repeat(30)) },
    } as unknown as DraftContent;
    const result = termCompleteness(rules, draft);
    expect(result.satisfied).toBe(0);
    expect(result.percent).toBe(0);
  });

  it('sem seções exigidas = 100%', () => {
    expect(completenessPercent(0, 0)).toBe(100);
  });
});

describe('termPatchSchema — condições contratuais (US-038 · RN-TR-28..32)', () => {
  const issue = (body: Record<string, unknown>) => {
    const result = termPatchSchema.safeParse(body);
    return result.success ? null : result.error.issues[0];
  };

  it('aceita as condições nos limites e null para limpar', () => {
    expect(
      termPatchSchema.safeParse({
        contractDurationMonths: 120,
        executionDeadline: 30,
        executionDeadlineType: 'CALENDAR',
        paymentTermDays: 90,
        productWarrantyMonths: 0,
        contractGuaranteePercent: '10.0000',
        allowsSubcontracting: false,
        awardType: 'BY_LOT',
        deliveryLocation: null,
        selectionCriterionId: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ contractDurationMonths: 0 }, TERM_CONDITION_MESSAGES.durationRange],
    [{ contractDurationMonths: 121 }, TERM_CONDITION_MESSAGES.durationRange],
    [{ paymentTermDays: 91 }, TERM_CONDITION_MESSAGES.paymentRange],
    [{ productWarrantyMonths: 121 }, TERM_CONDITION_MESSAGES.warrantyRange],
    [{ executionDeadline: 0 }, TERM_CONDITION_MESSAGES.deadlineRange],
    [{ contractGuaranteePercent: '10.0001' }, TERM_CONDITION_MESSAGES.guaranteeRange],
    [{ contractGuaranteePercent: '15' }, TERM_CONDITION_MESSAGES.guaranteeRange],
  ])('fora da faixa: %o', (body, message) => {
    expect(issue(body)?.message).toBe(message);
  });

  it('garantia contratual: formato inválido é INVALID_DECIMAL, acima de 10 é OUT_OF_RANGE', () => {
    expect(issue({ contractGuaranteePercent: '5,5' })).toMatchObject({
      params: { code: 'INVALID_DECIMAL' },
    });
    expect(issue({ contractGuaranteePercent: '1.23456' })).toMatchObject({
      params: { code: 'INVALID_DECIMAL' },
    });
    expect(issue({ contractGuaranteePercent: '15' })).toMatchObject({
      params: { code: 'OUT_OF_RANGE' },
    });
  });

  it('termDeadlineIssue (RN-TR-29): um exige o outro', () => {
    expect(termDeadlineIssue(30, null)).toMatchObject({
      field: 'executionDeadlineType',
      code: 'CONDITIONAL_REQUIRED',
      message: 'Informe o tipo de contagem do prazo.',
    });
    expect(termDeadlineIssue(null, 'BUSINESS')).toMatchObject({ field: 'executionDeadline' });
    expect(termDeadlineIssue(30, 'BUSINESS')).toBeNull();
    expect(termDeadlineIssue(null, null)).toBeNull();
  });
});

describe('itemRichTextIssue (US-038 · RN-TR-26)', () => {
  it('aceita ausente, null e texto até 50.000 caracteres', () => {
    expect(itemRichTextIssue(undefined)).toBeNull();
    expect(itemRichTextIssue(null)).toBeNull();
    expect(itemRichTextIssue(richTextFromPlainText('a'.repeat(50_000)))).toBeNull();
  });

  it('acima de 50.000 caracteres → TOO_LONG; fora do schema → RICH_TEXT_INVALID; > 1 MB → PAYLOAD_TOO_LARGE', () => {
    expect(itemRichTextIssue(richTextFromPlainText('a'.repeat(50_001)))).toBe('TOO_LONG');
    expect(itemRichTextIssue({ type: 'doc', content: [{ type: 'iframe' }] })).toBe(
      'RICH_TEXT_INVALID',
    );
    expect(itemRichTextIssue(richTextFromPlainText('a\n'.repeat(400_000)))).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });
});
