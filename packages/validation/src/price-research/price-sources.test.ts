import { describe, expect, it } from 'vitest';

import {
  createPriceSourceSchema,
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
