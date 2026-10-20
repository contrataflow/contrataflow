import { describe, expect, it } from 'vitest';

import { ETP_COMPLETENESS_MESSAGES, evaluateEtpCompleteness } from './etp-completeness.js';
import type { EtpCompletenessInput } from './etp-completeness.js';

const complete: EtpCompletenessInput = {
  conclusion: 'VIABLE',
  parcelingDecision: 'NOT_PARCELED',
  estimatedTotalValue: '125000.00',
  items: [{ quantity: '400.0000' }, { quantity: '12.5000' }],
  recommendedAlternatives: 1,
};

const codes = (input: EtpCompletenessInput) =>
  evaluateEtpCompleteness(input).map((item) => `${item.severity}:${item.code}:${item.field ?? ''}`);

describe('evaluateEtpCompleteness — RN-ETP-34..36', () => {
  it('VIABLE completo: nenhuma pendência', () => {
    expect(evaluateEtpCompleteness(complete)).toEqual([]);
  });

  it('RN-ETP-34: conclusão PENDING, parcelamento ausente e nenhum item com quantidade', () => {
    const violations = evaluateEtpCompleteness({
      ...complete,
      conclusion: 'PENDING',
      parcelingDecision: null,
      items: [{ quantity: '0.0000' }, { quantity: null }, { quantity: ' ' }],
    });
    expect(violations).toEqual([
      {
        code: 'FIELD_REQUIRED',
        severity: 'BLOCKING',
        message: 'Defina a conclusão do ETP (viável ou não viável).',
        ruleId: null,
        sectionKey: null,
        field: 'conclusion',
        itemId: null,
        params: {},
      },
      expect.objectContaining({
        code: 'FIELD_REQUIRED',
        field: 'parcelingDecision',
        message: 'Informe a decisão sobre o parcelamento.',
      }),
      expect.objectContaining({
        code: 'ITEMS_REQUIRED',
        field: 'items',
        message: 'Informe ao menos um item com quantidade.',
      }),
    ]);
  });

  it('PENDING não avalia as regras de VIABLE nem gera o aviso de NOT_VIABLE', () => {
    expect(
      codes({
        ...complete,
        conclusion: 'PENDING',
        recommendedAlternatives: 0,
        estimatedTotalValue: null,
      }),
    ).toEqual(['BLOCKING:FIELD_REQUIRED:conclusion']);
  });

  it('RN-ETP-35: VIABLE sem alternativa recomendada (ou com mais de uma) e sem valor estimado', () => {
    expect(codes({ ...complete, recommendedAlternatives: 0, estimatedTotalValue: null })).toEqual([
      'BLOCKING:ETP_RECOMMENDED_ALTERNATIVE_REQUIRED:recommendedAlternativeId',
      'BLOCKING:ETP_ESTIMATED_VALUE_REQUIRED:estimatedTotalValue',
    ]);
    expect(codes({ ...complete, recommendedAlternatives: 2 })).toEqual([
      'BLOCKING:ETP_RECOMMENDED_ALTERNATIVE_REQUIRED:recommendedAlternativeId',
    ]);
    expect(codes({ ...complete, estimatedTotalValue: '' })).toEqual([
      'BLOCKING:ETP_ESTIMATED_VALUE_REQUIRED:estimatedTotalValue',
    ]);
  });

  it('RN-ETP-36: NOT_VIABLE gera só o aviso (dispensa alternativa e valor), depois dos bloqueantes', () => {
    expect(
      codes({
        ...complete,
        conclusion: 'NOT_VIABLE',
        recommendedAlternatives: 0,
        estimatedTotalValue: null,
      }),
    ).toEqual(['WARNING:ETP_NOT_VIABLE_CONCLUSION:conclusion']);
    const [first, second] = evaluateEtpCompleteness({
      ...complete,
      conclusion: 'NOT_VIABLE',
      parcelingDecision: null,
    });
    expect(first).toMatchObject({ severity: 'BLOCKING', field: 'parcelingDecision' });
    expect(second).toMatchObject({
      severity: 'WARNING',
      message: ETP_COMPLETENESS_MESSAGES.notViableConclusion,
    });
  });
});
