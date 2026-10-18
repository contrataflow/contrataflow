import { describe, expect, it } from 'vitest';

import {
  applySourcePatch,
  createPriceSource,
  createQuotation,
  effectiveMaxAgeDays,
  fieldsOf,
  isSourceExpired,
  minusDays,
  missingRequiredFields,
  normalizeUnitPrice,
  planQuotationGrid,
  sourceDateErrors,
  validQuotationCounts,
  withPrice,
  withSourceFields,
} from './price-source.js';
import type { PriceSourceFields, PriceSourceTypeRules, Quotation } from './price-source.js';
import { PRICE_SOURCE_TYPE_SEED } from '../../../../test/support/price-source-fixtures.js';

/*
 * US-026 — regras puras de fontes e cotações: campos exigidos por tipo (RN-PRICE-21, para TODOS os
 * tipos semeados — DoD), datas não futuras (RN-PRICE-23), validade (RN-PRICE-26) e o upsert da grade
 * (RN-PRICE-24/25: linha vazia não altera; EXCLUDED nunca é sobrescrita).
 */

const NOW = new Date('2026-10-06T15:00:00.000Z');
const TODAY = '2026-10-06';
const PARAMETERS = { directQuoteMaxAgeDays: 180, similarContractMaxAgeDays: 365 };
const RESEARCH = { referenceDate: TODAY, parameters: PARAMETERS };

const EMPTY: PriceSourceFields = {
  sourceTypeId: 't',
  description: 'Fonte',
  supplierId: null,
  quoteDate: null,
  accessedAt: null,
  url: null,
  referenceOrganization: null,
  referenceDocument: null,
  supplierChoiceJustification: null,
  notes: null,
};

const COMPLETE: PriceSourceFields = {
  ...EMPTY,
  supplierId: 's',
  quoteDate: '2026-09-01',
  accessedAt: new Date('2026-09-12T14:32:00Z'),
  url: 'https://paineldeprecos.planejamento.gov.br',
  referenceOrganization: 'Prefeitura de Palhoça',
  referenceDocument: 'Contrato 12/2026',
  supplierChoiceJustification: 'Fornecedor do ramo com atuação na região.',
};

const rules = (overrides: Partial<PriceSourceTypeRules> = {}): PriceSourceTypeRules => ({
  id: 't',
  code: 'OUTRA',
  requiredFields: [],
  maxAgeDays: null,
  ageReference: 'quoteDate',
  ...overrides,
});

const seededType = (code: string) => {
  const item = PRICE_SOURCE_TYPE_SEED.find((candidate) => candidate.code === code);
  const metadata = (item?.metadata ?? {}) as {
    requiredFields?: PriceSourceTypeRules['requiredFields'];
    maxAgeDays?: number;
    ageReference?: 'quoteDate' | 'accessedAt';
  };
  return rules({
    code,
    requiredFields: metadata.requiredFields ?? [],
    maxAgeDays: metadata.maxAgeDays ?? null,
    ageReference: metadata.ageReference ?? 'quoteDate',
  });
};

function quotation(
  overrides: Partial<Pick<Quotation, 'id' | 'priceItemId' | 'unitPrice' | 'brandModel'>> = {},
): Quotation {
  return createQuotation({
    id: overrides.id ?? 'q1',
    tenantId: 'a',
    priceResearchId: 'r',
    priceItemId: overrides.priceItemId ?? 'i1',
    priceSourceId: 's1',
    unitPrice: overrides.unitPrice ?? '150.0000',
    brandModel: overrides.brandModel ?? null,
    isExpired: false,
    userId: 'u',
    now: NOW,
  });
}

describe('missingRequiredFields (RN-PRICE-21) — todos os tipos semeados', () => {
  it.each([
    ['PAINEL_PRECOS_PNCP', ['accessedAt']],
    ['CONTRATACAO_SIMILAR', ['quoteDate', 'referenceOrganization', 'referenceDocument']],
    ['MIDIA_ESPECIALIZADA', ['accessedAt', 'url']],
    ['SITIO_ELETRONICO', ['accessedAt', 'url']],
    ['TABELA_REFERENCIA', ['referenceDocument']],
    ['PESQUISA_DIRETA_FORNECEDOR', ['supplierId', 'quoteDate', 'supplierChoiceJustification']],
    ['NOTA_FISCAL_ELETRONICA', ['quoteDate', 'referenceDocument']],
    ['OUTRA', []],
  ])('%s exige %j (o anexo segue o upload — RN-PRICE-28)', (code, expected) => {
    expect(missingRequiredFields(EMPTY, seededType(code))).toEqual(expected);
    expect(missingRequiredFields(COMPLETE, seededType(code))).toEqual([]);
  });

  it('o semeado cobre todos os tipos do catálogo', () => {
    expect(PRICE_SOURCE_TYPE_SEED.map((item) => item.code)).toHaveLength(8);
  });
});

describe('sourceDateErrors (RN-PRICE-23 · V-05)', () => {
  it('data do orçamento depois de hoje e acesso no futuro → DATE_IN_PAST', () => {
    expect(
      sourceDateErrors(
        { quoteDate: '2026-10-07', accessedAt: new Date('2026-10-06T15:00:01Z') },
        { now: NOW, today: TODAY },
      ).map((error) => [error.field, error.code]),
    ).toEqual([
      ['quoteDate', 'DATE_IN_PAST'],
      ['accessedAt', 'DATE_IN_PAST'],
    ]);
  });

  it('hoje e agora são aceitos', () => {
    expect(
      sourceDateErrors({ quoteDate: TODAY, accessedAt: NOW }, { now: NOW, today: TODAY }),
    ).toEqual([]);
  });
});

describe('fonte: criação e edição (FA-01)', () => {
  const source = createPriceSource(COMPLETE, {
    id: 's1',
    tenantId: 'a',
    priceResearchId: 'r',
    processId: 'p',
    sortOrder: 0,
    userId: 'u',
    now: NOW,
  });

  it('cria na versão 1 com os campos', () => {
    expect(source).toMatchObject({ version: 1, sortOrder: 0, createdById: 'u' });
    expect(fieldsOf(source)).toEqual(COMPLETE);
  });

  it('PATCH: só os campos informados e diferentes mudam, na ordem do formulário', () => {
    const { fields, changed } = applySourcePatch(source, {
      notes: 'Obs.',
      description: COMPLETE.description,
      accessedAt: new Date('2026-09-12T14:32:00Z'),
      sourceTypeId: 't2',
      url: null,
    });
    expect(changed).toEqual(['sourceTypeId', 'url', 'notes']);
    expect(fields).toMatchObject({ sourceTypeId: 't2', url: null, notes: 'Obs.' });
    const next = withSourceFields(source, fields, { now: NOW, userId: 'v' });
    expect(next).toMatchObject({ url: null, updatedById: 'v', version: 1 });
  });
});

describe('validade (RN-PRICE-26)', () => {
  it('pesquisa direta e contratação similar usam o snapshot; outros, o catálogo; sem validade, nunca', () => {
    expect(effectiveMaxAgeDays(seededType('PESQUISA_DIRETA_FORNECEDOR'), PARAMETERS)).toBe(180);
    expect(
      effectiveMaxAgeDays(seededType('CONTRATACAO_SIMILAR'), {
        ...PARAMETERS,
        similarContractMaxAgeDays: 200,
      }),
    ).toBe(200);
    expect(effectiveMaxAgeDays(rules({ code: 'X', maxAgeDays: 30 }), PARAMETERS)).toBe(30);
    expect(effectiveMaxAgeDays(seededType('SITIO_ELETRONICO'), PARAMETERS)).toBeNull();
  });

  it('expira quando a data da fonte antecede data-base − validade', () => {
    const direct = seededType('PESQUISA_DIRETA_FORNECEDOR');
    expect(minusDays(TODAY, 180)).toBe('2026-04-09');
    const at = (quoteDate: string) =>
      isSourceExpired({ quoteDate, accessedAt: null }, direct, RESEARCH, 'America/Sao_Paulo');
    expect(at('2026-04-09')).toBe(false);
    expect(at('2026-04-08')).toBe(true);
    expect(isSourceExpired({ quoteDate: null, accessedAt: null }, direct, RESEARCH, 'UTC')).toBe(
      false,
    );
  });

  it('ageReference accessedAt usa a data local do acesso', () => {
    const type = rules({ code: 'X', maxAgeDays: 1, ageReference: 'accessedAt' });
    // 2026-10-05T02:00Z = 04/10 23:00 em São Paulo: anterior a 05/10 (06/10 − 1).
    const source = { quoteDate: null, accessedAt: new Date('2026-10-05T02:00:00Z') };
    expect(isSourceExpired(source, type, RESEARCH, 'America/Sao_Paulo')).toBe(true);
    expect(isSourceExpired(source, type, RESEARCH, 'UTC')).toBe(false);
    expect(isSourceExpired({ quoteDate: null, accessedAt: null }, type, RESEARCH, 'UTC')).toBe(
      false,
    );
    expect(isSourceExpired(source, seededType('SITIO_ELETRONICO'), RESEARCH, 'UTC')).toBe(false);
  });
});

describe('planQuotationGrid (RN-PRICE-24/25 · V-06/V-07)', () => {
  const itemIds = new Set(['i1', 'i2', 'i3']);

  it('cria, atualiza, ignora linha vazia e a idêntica; normaliza com 4 casas', () => {
    const existing = new Map([
      ['i2', quotation({ id: 'q2', priceItemId: 'i2', unitPrice: '80.0000' })],
      ['i3', quotation({ id: 'q3', priceItemId: 'i3', unitPrice: '10.0000' })],
    ]);
    const plan = planQuotationGrid({
      lines: [
        { priceItemId: 'i1', unitPrice: '150', brandModel: 'Votoran' },
        { priceItemId: 'i2', unitPrice: '81.50' },
        { priceItemId: 'i3', unitPrice: '10.00' },
      ],
      itemIds,
      existing,
      unitPriceDecimals: 2,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.excluded).toEqual([]);
    expect(
      plan.writes.map((write) => [write.priceItemId, write.unitPrice, write.existing?.id ?? null]),
    ).toEqual([
      ['i1', '150.0000', null],
      ['i2', '81.5000', 'q2'],
    ]);
    const empty = planQuotationGrid({
      lines: [{ priceItemId: 'i1', unitPrice: ' ' }, { priceItemId: 'i2' }],
      itemIds,
      existing,
      unitPriceDecimals: 2,
    });
    expect(empty.writes).toEqual([]);
    expect(empty.errors).toEqual([]);
  });

  it('preço zero, negativo, com casas a mais ou só marca → INVALID_DECIMAL; item fora → REFERENCE_NOT_FOUND', () => {
    const plan = planQuotationGrid({
      lines: [
        { priceItemId: 'i1', unitPrice: '0' },
        { priceItemId: 'i2', unitPrice: '1.234' },
        { priceItemId: 'outro', unitPrice: '1' },
        { priceItemId: 'i3', brandModel: 'Marca' },
      ],
      itemIds,
      existing: new Map(),
      unitPriceDecimals: 2,
    });
    expect(plan.errors.map((error) => [error.field, error.code])).toEqual([
      ['items[0].unitPrice', 'INVALID_DECIMAL'],
      ['items[1].unitPrice', 'INVALID_DECIMAL'],
      ['items[2].priceItemId', 'REFERENCE_NOT_FOUND'],
      ['items[3].unitPrice', 'INVALID_DECIMAL'],
    ]);
    expect(plan.writes).toEqual([]);
  });

  it('cotação EXCLUDED nunca é sobrescrita (linha vazia sobre ela não altera)', () => {
    const excluded = {
      ...quotation({ id: 'qx', priceItemId: 'i1' }),
      status: 'EXCLUDED' as const,
      exclusionReason: 'EXCESSIVE' as const,
      exclusionJustification: 'Preço muito acima dos demais orçamentos.',
    };
    const existing = new Map([['i1', excluded]]);
    expect(
      planQuotationGrid({
        lines: [{ priceItemId: 'i1', unitPrice: '99' }],
        itemIds,
        existing,
        unitPriceDecimals: 2,
      }).excluded,
    ).toEqual([0]);
    expect(
      planQuotationGrid({
        lines: [{ priceItemId: 'i1', unitPrice: null }],
        itemIds,
        existing,
        unitPriceDecimals: 2,
      }),
    ).toEqual({ writes: [], errors: [], excluded: [] });
  });
});

describe('cotações: preço e contagem', () => {
  it('normalizeUnitPrice com decimal.js', () => {
    expect(normalizeUnitPrice('0150.5')).toBe('150.5000');
    expect(normalizeUnitPrice('12345678901234.1234')).toBe('12345678901234.1234');
  });

  it('withPrice muda preço, marca e validade sem mexer na versão', () => {
    const next = withPrice(
      quotation(),
      { unitPrice: '1.0000', brandModel: 'X', isExpired: true },
      { now: NOW, userId: 'v' },
    );
    expect(next).toMatchObject({
      unitPrice: '1.0000',
      brandModel: 'X',
      isExpired: true,
      version: 1,
    });
  });

  it('validQuotationCounts conta só VALID por item', () => {
    expect(
      validQuotationCounts([
        { priceItemId: 'i1', status: 'VALID' },
        { priceItemId: 'i1', status: 'VALID' },
        { priceItemId: 'i2', status: 'EXCLUDED' },
      ]),
    ).toEqual(new Map([['i1', 2]]));
  });
});
