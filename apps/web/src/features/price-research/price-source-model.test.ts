import type { CatalogItemDto, PriceSourceDto, QuotationDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { priceItem } from '@test/support/price-research-fixtures';
import { ID } from '@test/support/process-fixtures';

import {
  EMPTY_EXCLUSION_FORM,
  EMPTY_SOURCE_FORM,
  createSourceBody,
  excludeBodyOf,
  formFromSource,
  gridLines,
  gridRows,
  initialGridCells,
  isoToLocalDateTime,
  leavesItemWithoutValidQuotation,
  localDateTimeToIso,
  sourceTypeOptions,
  toApiDecimal,
  toInputDecimal,
  updateSourceBody,
  validateExclusionForm,
  validateSourceForm,
} from './price-source-model';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const CLOCK = { now: NOW, today: '2026-10-16' };

const DIRECT = {
  id: ID(720),
  code: 'PESQUISA_DIRETA_FORNECEDOR',
  label: 'Pesquisa direta com fornecedor',
  requiredFields: ['supplierId', 'quoteDate', 'attachment', 'supplierChoiceJustification'] as const,
  maxAgeDays: 180,
};

function quotation(n: number, extra: Partial<QuotationDto> = {}): QuotationDto {
  return {
    id: ID(800 + n),
    priceResearchId: ID(701),
    priceItemId: ID(950 + n),
    priceSourceId: ID(730),
    unitPrice: '150.0000',
    unitPriceMasked: false,
    brandModel: null,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    outlierFlag: 'NONE',
    isExpired: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...extra,
  };
}

function source(extra: Partial<PriceSourceDto> = {}): PriceSourceDto {
  return {
    id: ID(730),
    priceResearchId: ID(701),
    sourceTypeId: DIRECT.id,
    sourceType: { ...DIRECT, requiredFields: [...DIRECT.requiredFields], isActive: true },
    description: 'Orçamento Construtora XYZ',
    supplierId: ID(740),
    supplier: { id: ID(740), legalName: 'Construtora XYZ', documentNumber: '11222333000181' },
    quoteDate: '2026-09-30',
    accessedAt: null,
    url: null,
    referenceOrganization: null,
    referenceDocument: null,
    supplierChoiceJustification: 'Atua na região.',
    notes: null,
    sortOrder: 0,
    quotations: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    ...extra,
  };
}

describe('tipos de fonte (RN-PRICE-21)', () => {
  it('lê requiredFields e maxAgeDays da metadata do catálogo', () => {
    const items = [
      {
        id: ID(720),
        code: 'PESQUISA_DIRETA_FORNECEDOR',
        label: 'Pesquisa direta',
        metadata: { requiredFields: ['supplierId', 'desconhecido'], maxAgeDays: 180 },
      },
      { id: ID(721), code: 'OUTRA', label: 'Outra', metadata: {} },
    ] as unknown as CatalogItemDto[];
    expect(sourceTypeOptions(items)).toEqual([
      {
        id: ID(720),
        code: 'PESQUISA_DIRETA_FORNECEDOR',
        label: 'Pesquisa direta',
        requiredFields: ['supplierId'],
        maxAgeDays: 180,
      },
      { id: ID(721), code: 'OUTRA', label: 'Outra', requiredFields: [], maxAgeDays: null },
    ]);
    expect(sourceTypeOptions(undefined)).toEqual([]);
  });
});

describe('formulário da fonte (V-01/V-04/V-05 · FA-06)', () => {
  it('sem tipo, sem descrição e sem os campos do tipo', () => {
    expect(validateSourceForm(EMPTY_SOURCE_FORM, undefined, CLOCK)).toEqual({
      sourceTypeId: 'Selecione o tipo de fonte.',
      description: 'Informe a descrição.',
    });
    expect(
      validateSourceForm({ ...EMPTY_SOURCE_FORM, description: 'Orçamento' }, DIRECT, CLOCK),
    ).toEqual({
      supplierId: 'Selecione o fornecedor',
      quoteDate: 'Campo obrigatório para este tipo de fonte.',
      supplierChoiceJustification: 'Campo obrigatório para este tipo de fonte.',
    });
  });

  it('URL sem https, datas futuras e tamanho da descrição', () => {
    const errors = validateSourceForm(
      {
        ...EMPTY_SOURCE_FORM,
        description: 'x'.repeat(301),
        url: 'http://exemplo.gov.br',
        quoteDate: '2026-10-17',
        accessedAt: '2099-01-01T10:00',
      },
      { ...DIRECT, requiredFields: [] },
      CLOCK,
    );
    expect(errors).toEqual({
      description: 'Informe no máximo 300 caracteres.',
      url: 'Informe um endereço iniciado por https://.',
      quoteDate: 'A data informada não pode ser futura.',
      accessedAt: 'A data informada não pode ser futura.',
    });
  });

  it('corpo do PRS-10 e PATCH só com o que mudou', () => {
    const values = formFromSource(source());
    expect(createSourceBody(values)).toMatchObject({
      sourceTypeId: DIRECT.id,
      supplierId: ID(740),
      quoteDate: '2026-09-30',
      accessedAt: null,
      url: null,
    });
    expect(updateSourceBody(values, source())).toBeNull();
    expect(updateSourceBody({ ...values, notes: ' Obs. ', url: '' }, source())).toEqual({
      notes: 'Obs.',
    });
  });

  it('data/hora de acesso local ↔ ISO em UTC', () => {
    const iso = localDateTimeToIso('2026-09-12T14:32');
    expect(iso).toMatch(/^2026-09-1\dT\d{2}:32:00Z$/);
    expect(isoToLocalDateTime(iso)).toBe('2026-09-12T14:32');
    expect(localDateTimeToIso('')).toBeNull();
    expect(isoToLocalDateTime(null)).toBe('');
  });
});

describe('grade de preços (RN-PRICE-24/25 · V-06)', () => {
  const items = [priceItem(1), priceItem(2), priceItem(3)];

  it('decimais: vírgula ↔ ponto', () => {
    expect(toApiDecimal(' 1.234,56 ')).toBe('1234.56');
    expect(toApiDecimal('150.5')).toBe('150.5');
    expect(toInputDecimal('150.5000', 2)).toBe('150,50');
    expect(toInputDecimal(null, 4)).toBe('');
  });

  it('envia só linhas novas ou alteradas; vazias e EXCLUDED não vão; preço inválido marca a célula', () => {
    const rows = gridRows(
      items,
      source({
        quotations: [
          quotation(1),
          quotation(3, { status: 'EXCLUDED', exclusionReason: 'EXCESSIVE' }),
        ],
      }),
    );
    expect(rows.map((row) => row.excluded)).toEqual([false, false, true]);
    const cells = initialGridCells(rows, 2);
    expect(cells[ID(951)]).toEqual({ unitPrice: '150,00', brandModel: '' });
    expect(gridLines(rows, cells, 2)).toEqual({ lines: [], errors: {} });

    const edited = gridLines(
      rows,
      {
        ...cells,
        [ID(951)]: { unitPrice: '150,00', brandModel: 'Votoran' },
        [ID(952)]: { unitPrice: '80', brandModel: '' },
        [ID(953)]: { unitPrice: '1', brandModel: '' },
      },
      2,
    );
    expect(edited).toEqual({
      lines: [
        { priceItemId: ID(951), unitPrice: '150.00', brandModel: 'Votoran' },
        { priceItemId: ID(952), unitPrice: '80', brandModel: null },
      ],
      errors: {},
    });
    const invalid = gridLines(
      rows,
      {
        ...cells,
        [ID(951)]: { unitPrice: '0', brandModel: '' },
        [ID(952)]: { unitPrice: '', brandModel: 'X' },
      },
      2,
    );
    expect(invalid.errors).toEqual({
      [ID(951)]: 'Informe um preço válido, maior que zero.',
      [ID(952)]: 'Informe um preço válido, maior que zero.',
    });
    expect(invalid.lines).toEqual([]);
  });
});

describe('desconsiderar cotação (US-027 · V-01/V-02)', () => {
  const JUSTIFICATION = 'Preço muito acima das demais cotações do mesmo item';

  it('validateExclusionForm: motivo escolhido e justificativa com 20+ caracteres (aparada)', () => {
    expect(validateExclusionForm(EMPTY_EXCLUSION_FORM)).toEqual({
      reason: 'Selecione o motivo.',
      justification: 'A justificativa deve ter no mínimo 20 caracteres.',
    });
    expect(validateExclusionForm({ reason: 'EXCESSIVE', justification: 'Preço alto' })).toEqual({
      justification: 'A justificativa deve ter no mínimo 20 caracteres.',
    });
    // Só espaços não conta; 20 caracteres exatos passam.
    expect(
      validateExclusionForm({ reason: 'EXCESSIVE', justification: `  ${'a'.repeat(19)}  ` }),
    ).toHaveProperty('justification');
    expect(validateExclusionForm({ reason: 'OTHER', justification: 'a'.repeat(20) })).toEqual({});
    expect(validateExclusionForm({ reason: 'INCONSISTENT', justification: JUSTIFICATION })).toEqual(
      {},
    );
  });

  it('excludeBodyOf: corpo do PRS-16 com a justificativa aparada; sem motivo não há corpo', () => {
    expect(excludeBodyOf({ reason: 'INCONSISTENT', justification: `  ${JUSTIFICATION} ` })).toEqual(
      {
        exclusionReason: 'INCONSISTENT',
        exclusionJustification: JUSTIFICATION,
      },
    );
    expect(excludeBodyOf({ reason: '', justification: JUSTIFICATION })).toBeNull();
  });

  it('FA-01: só a última cotação válida do item deixa o item sem cotação válida', () => {
    const [last, many, excluded] = gridRows(
      [
        priceItem(1, { validQuotationsCount: 1 }),
        priceItem(2, { validQuotationsCount: 3 }),
        priceItem(3, { validQuotationsCount: 0 }),
      ],
      {
        quotations: [
          quotation(1),
          quotation(2),
          quotation(3, { status: 'EXCLUDED', exclusionReason: 'OTHER' }),
        ],
      },
    );
    expect(last && leavesItemWithoutValidQuotation(last)).toBe(true);
    expect(many && leavesItemWithoutValidQuotation(many)).toBe(false);
    expect(excluded && leavesItemWithoutValidQuotation(excluded)).toBe(false);
  });
});
