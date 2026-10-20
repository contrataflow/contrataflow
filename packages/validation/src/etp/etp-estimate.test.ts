import { describe, expect, it } from 'vitest';

import {
  ETP_ESTIMATE_MESSAGES,
  etpEstimatedValueIssue,
  etpEstimateIssues,
  etpPatchTouchesEstimate,
  etpUpdateSchema,
  normalizeEtpMoney,
} from './etp-estimate.js';
import {
  calculationMemoBytes,
  calculationMemoIssue,
  documentItemInputSchema,
} from '../document/document-items.js';
import { RICH_TEXT_MAX_BYTES } from '../document/rich-text.js';

const RESEARCH = '0192f0a0-0000-7000-8000-000000000301';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('etpUpdateSchema — ETP-04 (US-022 · RN-ETP-28)', () => {
  it('aceita valor manual com até 2 casas e o vínculo à pesquisa', () => {
    expect(
      etpUpdateSchema.safeParse({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '125000.5' })
        .success,
    ).toBe(true);
    expect(
      etpUpdateSchema.safeParse({
        estimatedValueSource: 'PRICE_RESEARCH',
        priceResearchId: RESEARCH,
      }).success,
    ).toBe(true);
  });

  it.each(['-1', '10.123', '1,50', 'abc', '01'])(
    'V-05: valor %s → INVALID_DECIMAL',
    (estimatedTotalValue) => {
      const result = etpUpdateSchema.safeParse({
        estimatedValueSource: 'MANUAL',
        estimatedTotalValue,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        path: ['estimatedTotalValue'],
        message: ETP_ESTIMATE_MESSAGES.valueInvalid,
      });
    },
  );

  it('é estrito; US-023: conclusão VIABLE/NOT_VIABLE e decisão sobre o parcelamento', () => {
    expect(etpUpdateSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(etpUpdateSchema.safeParse({ conclusion: 'VIABLE' }).success).toBe(true);
    expect(etpUpdateSchema.safeParse({ conclusion: 'NOT_VIABLE' }).success).toBe(true);
    expect(etpUpdateSchema.safeParse({ conclusion: 'PENDING' }).success).toBe(false);
    expect(etpUpdateSchema.safeParse({ parcelingDecision: 'PARCELED' }).success).toBe(true);
    expect(etpUpdateSchema.safeParse({ parcelingDecision: 'TALVEZ' }).success).toBe(false);
  });

  it('US-023: corpo só com conclusão/parcelamento não passa pelas regras das estimativas', () => {
    expect(etpPatchTouchesEstimate({ conclusion: 'VIABLE' })).toBe(false);
    expect(etpEstimateIssues({ parcelingDecision: 'NOT_PARCELED' })).toEqual([]);
    expect(etpPatchTouchesEstimate({ conclusion: 'VIABLE', estimatedTotalValue: '1.00' })).toBe(
      true,
    );
    expect(etpPatchTouchesEstimate({})).toBe(true);
  });
});

describe('etpEstimateIssues — RN-ETP-28', () => {
  it('V-04: sem origem → REQUIRED em estimatedValueSource (com ou sem valor)', () => {
    for (const patch of [{}, { estimatedTotalValue: '10.00' }]) {
      expect(etpEstimateIssues(patch)).toEqual([
        {
          field: 'estimatedValueSource',
          code: 'REQUIRED',
          message: 'Escolha como o valor estimado será definido.',
        },
      ]);
    }
  });

  it('MANUAL exige o valor e recusa a pesquisa', () => {
    expect(
      etpEstimateIssues({ estimatedValueSource: 'MANUAL', priceResearchId: RESEARCH }),
    ).toEqual([
      expect.objectContaining({ field: 'estimatedTotalValue', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'priceResearchId', code: 'NOT_ALLOWED' }),
    ]);
    expect(etpEstimateIssues({ estimatedValueSource: 'MANUAL', estimatedTotalValue: '0' })).toEqual(
      [],
    );
  });

  it('PRICE_RESEARCH exige a pesquisa e recusa o valor (somente leitura)', () => {
    expect(
      etpEstimateIssues({ estimatedValueSource: 'PRICE_RESEARCH', estimatedTotalValue: '1.00' }),
    ).toEqual([
      expect.objectContaining({ field: 'priceResearchId', code: 'REQUIRED' }),
      expect.objectContaining({ field: 'estimatedTotalValue', code: 'NOT_ALLOWED' }),
    ]);
    expect(
      etpEstimateIssues({ estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: RESEARCH }),
    ).toEqual([]);
  });

  it('valor digitado: vazio → REQUIRED, inválido → INVALID_DECIMAL', () => {
    expect(etpEstimatedValueIssue(' ')).toMatchObject({ code: 'REQUIRED' });
    expect(etpEstimatedValueIssue('1.234')).toMatchObject({ code: 'INVALID_DECIMAL' });
    expect(etpEstimatedValueIssue('1234.5')).toBeNull();
  });

  it('normaliza para 2 casas', () => {
    expect(normalizeEtpMoney('125000')).toBe('125000.00');
    expect(normalizeEtpMoney('0.5')).toBe('0.50');
    expect(normalizeEtpMoney('7.25')).toBe('7.25');
  });
});

describe('memória de cálculo do item (RN-ETP-27 · V-03)', () => {
  it('aceita rich text permitido e ausência', () => {
    expect(calculationMemoIssue(doc('Consumo médio mensal (50) × 10 meses de obra'))).toBeNull();
    expect(calculationMemoIssue(null)).toBeNull();
    expect(calculationMemoIssue(undefined)).toBeNull();
    expect(calculationMemoBytes(null)).toBe(0);
  });

  it('nó fora do schema → RICH_TEXT_INVALID', () => {
    expect(calculationMemoIssue({ type: 'doc', content: [{ type: 'script' }] })).toBe(
      'RICH_TEXT_INVALID',
    );
    expect(calculationMemoIssue({ type: 'paragraph' })).toBe('RICH_TEXT_INVALID');
  });

  it('acima de 1 MB → PAYLOAD_TOO_LARGE (antes de percorrer o schema)', () => {
    const big = doc('x'.repeat(RICH_TEXT_MAX_BYTES));
    expect(calculationMemoIssue(big)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('o DOC-07 aceita calculationMemo opcional e nulo', () => {
    const base = { processItemId: RESEARCH, quantity: '500' };
    expect(documentItemInputSchema.safeParse(base).success).toBe(true);
    expect(documentItemInputSchema.safeParse({ ...base, calculationMemo: null }).success).toBe(
      true,
    );
    expect(
      documentItemInputSchema.safeParse({ ...base, calculationMemo: doc('memória') }).success,
    ).toBe(true);
    expect(documentItemInputSchema.safeParse({ ...base, calculationMemo: 'texto' }).success).toBe(
      false,
    );
  });
});
