import { describe, expect, it } from 'vitest';

import {
  createPriceSourceSchema,
  EXCLUSION_REASONS,
  excludeQuotationSchema,
  isHttpsUrl,
  missingPriceSourceFields,
  PRICE_SOURCE_MESSAGES,
  unitPriceIssue,
  updatePriceSourceSchema,
  updateQuotationSchema,
  upsertQuotationsSchema,
} from './price-sources.js';

const TYPE = '0192d026-0000-7000-8000-000000000001';
const ITEM = '0192d026-0000-7000-8000-000000000002';

const codes = (result: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (result.error?.issues ?? []).map((issue) => {
    const { path, params, code } = issue as {
      path: (string | number)[];
      params?: { code?: string };
      code: string;
    };
    return [path.join('.'), params?.code ?? code];
  });

describe('missingPriceSourceFields (RN-PRICE-21 · V-01)', () => {
  it('lista os campos exigidos ausentes na ordem do catálogo, sem o anexo (RN-PRICE-28)', () => {
    expect(
      missingPriceSourceFields({ quoteDate: '2026-09-01', supplierChoiceJustification: '  ' }, [
        'supplierId',
        'quoteDate',
        'attachment',
        'supplierChoiceJustification',
      ]),
    ).toEqual(['supplierId', 'supplierChoiceJustification']);
  });

  it('nada faltando quando o tipo não exige campos', () => {
    expect(missingPriceSourceFields({}, [])).toEqual([]);
  });

  it('mensagem com os rótulos dos campos', () => {
    expect(PRICE_SOURCE_MESSAGES.requiredFields(['supplierId', 'quoteDate'])).toBe(
      'Para este tipo de fonte, informe: fornecedor, data do orçamento/documento.',
    );
  });
});

describe('unitPriceIssue (RN-PRICE-24 · V-06)', () => {
  it.each(['150', '150.00', '0.01', '12345678901234.99'])('%s é válido com 2 casas', (value) => {
    expect(unitPriceIssue(value, 2)).toBeNull();
  });

  it.each(['0', '0.00', '-1', '1,50', '1.234', '', 'abc', '123456789012345'])(
    '%s é inválido com 2 casas',
    (value) => {
      expect(unitPriceIssue(value, 2)?.code).toBe('INVALID_DECIMAL');
    },
  );

  it('4 casas quando o snapshot permite', () => {
    expect(unitPriceIssue('1.2345', 4)).toBeNull();
    expect(unitPriceIssue('1.23456', 4)?.code).toBe('INVALID_DECIMAL');
    expect(unitPriceIssue(null, 4)?.code).toBe('INVALID_DECIMAL');
  });
});

describe('contratos (PRS-10/11/13/14)', () => {
  it('URL sem https:// → INVALID_FORMAT (V-04); vazios viram null', () => {
    expect(isHttpsUrl('https://paineldeprecos.planejamento.gov.br')).toBe(true);
    expect(isHttpsUrl('http://exemplo.gov.br')).toBe(false);
    const result = createPriceSourceSchema.safeParse({
      sourceTypeId: TYPE,
      description: 'Painel',
      url: 'http://exemplo.gov.br',
    });
    expect(codes(result)).toEqual([['url', 'INVALID_FORMAT']]);
    const ok = createPriceSourceSchema.parse({
      sourceTypeId: TYPE,
      description: ' Painel ',
      url: '',
      referenceDocument: '',
    });
    expect(ok).toMatchObject({ description: 'Painel', url: null, referenceDocument: null });
  });

  it('descrição obrigatória e até 300 caracteres', () => {
    expect(
      codes(createPriceSourceSchema.safeParse({ sourceTypeId: TYPE, description: ' ' })),
    ).toEqual([['description', 'too_small']]);
    expect(
      codes(
        createPriceSourceSchema.safeParse({ sourceTypeId: TYPE, description: 'x'.repeat(301) }),
      ),
    ).toEqual([['description', 'too_big']]);
  });

  it('PATCH vazio é recusado', () => {
    expect(updatePriceSourceSchema.safeParse({}).success).toBe(false);
    expect(updatePriceSourceSchema.safeParse({ notes: null }).success).toBe(true);
    expect(updateQuotationSchema.safeParse({}).success).toBe(false);
  });

  it('US-030 V-01: outlierFlag/isExpired no PATCH da cotação → NOT_ALLOWED no campo', () => {
    expect(codes(updateQuotationSchema.safeParse({ outlierFlag: 'NONE' }))).toEqual([
      ['outlierFlag', 'NOT_ALLOWED'],
    ]);
    const both = updateQuotationSchema.safeParse({ unitPrice: '10', isExpired: false });
    expect(codes(both)).toEqual([['isExpired', 'NOT_ALLOWED']]);
    expect(both.error?.issues[0]?.message).toBe(
      'Este campo é calculado pelo sistema e não pode ser alterado diretamente.',
    );
  });

  it('grade sem item repetido (DUPLICATE_IN_LIST)', () => {
    const result = upsertQuotationsSchema.safeParse({
      items: [
        { priceItemId: ITEM, unitPrice: '1' },
        { priceItemId: ITEM, unitPrice: '2' },
      ],
    });
    expect(codes(result)).toEqual([['items.1.priceItemId', 'DUPLICATE_IN_LIST']]);
  });
});

describe('excludeQuotationSchema (US-027 · V-01/V-02)', () => {
  const JUSTIFICATION = 'Preço muito acima das demais cotações do mesmo item';

  it('aceita motivo do enum e justificativa com 20+ caracteres (aparada)', () => {
    const parsed = excludeQuotationSchema.parse({
      exclusionReason: 'INCONSISTENT',
      exclusionJustification: `  ${JUSTIFICATION}  `,
    });
    expect(parsed).toEqual({
      exclusionReason: 'INCONSISTENT',
      exclusionJustification: JUSTIFICATION,
    });
    for (const reason of EXCLUSION_REASONS) {
      expect(
        excludeQuotationSchema.safeParse({
          exclusionReason: reason,
          exclusionJustification: JUSTIFICATION,
        }).success,
      ).toBe(true);
    }
  });

  it('justificativa curta → too_small (TOO_SHORT na API); 20 caracteres exatos passam', () => {
    const short = excludeQuotationSchema.safeParse({
      exclusionReason: 'EXCESSIVE',
      exclusionJustification: 'Preço alto',
    });
    expect(codes(short)).toEqual([['exclusionJustification', 'too_small']]);
    expect(short.error?.issues[0]?.message).toBe(PRICE_SOURCE_MESSAGES.exclusionJustificationShort);
    expect(
      excludeQuotationSchema.safeParse({
        exclusionReason: 'EXCESSIVE',
        exclusionJustification: 'a'.repeat(20),
      }).success,
    ).toBe(true);
    // Só espaços conta como vazio.
    expect(
      excludeQuotationSchema.safeParse({
        exclusionReason: 'OTHER',
        exclusionJustification: ' '.repeat(40),
      }).success,
    ).toBe(false);
  });

  it('motivo ausente → invalid_type (REQUIRED); fora do enum → invalid_value; campo extra recusado', () => {
    const missing = excludeQuotationSchema.safeParse({ exclusionJustification: JUSTIFICATION });
    expect(codes(missing)).toEqual([['exclusionReason', 'invalid_type']]);
    expect(missing.error?.issues[0]?.message).toBe(PRICE_SOURCE_MESSAGES.exclusionReasonRequired);
    const unknown = excludeQuotationSchema.safeParse({
      exclusionReason: 'OUTRO',
      exclusionJustification: JUSTIFICATION,
    });
    expect(codes(unknown)).toEqual([['exclusionReason', 'invalid_value']]);
    expect(
      excludeQuotationSchema.safeParse({
        exclusionReason: 'OTHER',
        exclusionJustification: JUSTIFICATION,
        status: 'EXCLUDED',
      }).success,
    ).toBe(false);
  });

  it('limita a justificativa a 4000 caracteres', () => {
    expect(
      excludeQuotationSchema.safeParse({
        exclusionReason: 'OTHER',
        exclusionJustification: 'a'.repeat(4001),
      }).success,
    ).toBe(false);
  });
});
