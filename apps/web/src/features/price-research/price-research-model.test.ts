import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { priceItem, priceResearchDto, processItem } from '@test/support/price-research-fixtures';
import { ID } from '@test/support/process-fixtures';

import {
  addItemsPayload,
  canSubmit,
  createBodyOf,
  existingResearchId,
  headerIssues,
  isItemsRequired,
  mapValidationErrors,
  methodBadge,
  methodBodyOf,
  methodChanged,
  methodDraftOf,
  methodIssues,
  missingProcessItems,
  parametersDraftOf,
  parametersPatchOf,
  researchRows,
  rowIssue,
} from './price-research-model';
import type { ResearchRow } from './price-research-model';

const units = new Map<string, boolean>();

describe('researchRows', () => {
  it('ordena por número, marca todas e pré-preenche a quantidade de referência', () => {
    const rows = researchRows([processItem(2, '1.5000'), processItem(1, null)], units, {});
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(rows.every((row) => row.selected)).toBe(true);
    expect(rows.map((row) => row.quantity)).toEqual(['', '1.5']);
  });

  it('aplica as edições do usuário', () => {
    const rows = researchRows([processItem(1, '3.0000')], units, {
      [ID(901)]: { selected: false, quantity: '9' },
    });
    expect(rows[0]).toMatchObject({ selected: false, quantity: '9' });
  });
});

describe('rowIssue', () => {
  const [first] = researchRows(
    [processItem(1, null)],
    new Map([[processItem(1, null).unitOfMeasure.id, false]]),
    {},
  );
  if (first === undefined) throw new Error('Linha ausente.');
  const row: ResearchRow = first;
  it('quantidade ausente é MISSING (FA-03); linha desmarcada não tem problema', () => {
    expect(rowIssue(row)).toBe('MISSING');
    expect(rowIssue({ ...row, selected: false })).toBeNull();
  });
  it('aceita vírgula e recusa fração em unidade inteira (V-04)', () => {
    expect(rowIssue({ ...row, quantity: '2' })).toBeNull();
    expect(rowIssue({ ...row, quantity: '2,5' })).toEqual({
      message: 'Esta unidade aceita apenas números inteiros.',
    });
    expect(rowIssue({ ...row, quantity: '0' })).toEqual({
      message: 'Informe uma quantidade maior que zero (até 4 casas decimais).',
    });
  });
});

describe('corpo e validação do cabeçalho', () => {
  const rows = researchRows([processItem(1, '2.0000'), processItem(2, null)], units, {
    [ID(902)]: { quantity: '4' },
  });
  const draft = {
    title: 'Pesquisa do cimento',
    referenceDate: '2026-10-16',
    rows,
    today: '2026-10-17',
  };

  it('monta o corpo só com as linhas marcadas', () => {
    expect(createBodyOf(draft)).toEqual({
      title: 'Pesquisa do cimento',
      referenceDate: '2026-10-16',
      items: [
        { processItemId: ID(901), quantity: '2' },
        { processItemId: ID(902), quantity: '4' },
      ],
    });
    expect(canSubmit(draft)).toBe(true);
  });

  it('V-05/V-06/V-01: data futura, título curto e nenhum item', () => {
    expect(headerIssues({ ...draft, referenceDate: '2026-10-18' }).referenceDate).toBe(
      'A data-base não pode ser posterior a hoje.',
    );
    expect(headerIssues({ ...draft, referenceDate: '' }).referenceDate).toBe(
      'Informe a data-base.',
    );
    expect(headerIssues({ ...draft, title: 'Abc' }).title).toBe(
      'O título deve ter entre 5 e 250 caracteres.',
    );
    const none = { ...draft, rows: rows.map((row) => ({ ...row, selected: false })) };
    expect(headerIssues(none).items).toBe('Selecione ao menos um item.');
    expect(canSubmit(none)).toBe(false);
  });
});

describe('erros da API', () => {
  const submitted = [{ processItemId: ID(901) }, { processItemId: ID(902) }];

  it('mapeia items[i].quantity para a linha e os demais campos para o cabeçalho', () => {
    const error = new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [
        { field: 'items[1].quantity', code: 'OUT_OF_RANGE', message: 'Ruim.' },
        { field: 'items.0.processItemId', code: 'REFERENCE_NOT_FOUND', message: 'Outro processo.' },
        { field: 'referenceDate', code: 'OUT_OF_RANGE', message: 'Futura.' },
        { field: 'outro', code: 'REQUIRED', message: 'Solto.' },
      ],
    });
    const mapped = mapValidationErrors(error, submitted);
    expect(mapped.rows.get(ID(902))).toBe('Ruim.');
    expect(mapped.rows.get(ID(901))).toBe('Outro processo.');
    expect(mapped.header.referenceDate).toBe('Futura.');
    expect(mapped.unmapped).toEqual(['Solto.']);
  });

  it('reconhece PRICE_ITEMS_REQUIRED e meta.existingId', () => {
    const violation = {
      code: 'PRICE_ITEMS_REQUIRED',
      severity: 'BLOCKING' as const,
      message: 'x',
      ruleId: null,
      sectionKey: null,
      field: null,
      itemId: null,
      params: {},
    };
    expect(
      isItemsRequired(
        new ApiError({ status: 422, code: 'BUSINESS_RULE_VIOLATION', violations: [violation] }),
      ),
    ).toBe(true);
    expect(isItemsRequired(new ApiError({ status: 422, code: 'VALIDATION_ERROR' }))).toBe(false);
    expect(
      existingResearchId(new ApiError({ status: 409, code: 'DOCUMENT_ALREADY_EXISTS' })),
    ).toBeNull();
  });
});

describe('itens faltantes (FA-04)', () => {
  it('lista os itens do processo ausentes da pesquisa e monta o PRS-06', () => {
    const missing = missingProcessItems(
      [processItem(1, '1.0000'), processItem(2, null), processItem(3, '2.5000')],
      [priceItem(1)],
    );
    expect(missing.map((item) => item.sequence)).toEqual([2, 3]);
    expect(addItemsPayload(missing)).toEqual([
      { processItemId: ID(902) },
      { processItemId: ID(903), quantity: '2.5' },
    ]);
  });
});

describe('método do item e parâmetros (US-029)', () => {
  const JUSTIFICATION = 'Valor de ata vigente do consórcio regional';
  const manualItem = priceItem(1, {
    methodOverride: 'MANUAL',
    manualUnitPrice: '95.5000',
    manualJustification: JUSTIFICATION,
  });

  it('rascunho a partir do item e detecção de mudança (reenvio igual não grava)', () => {
    expect(methodDraftOf(priceItem(1))).toEqual({
      methodOverride: '',
      manualUnitPrice: '',
      manualJustification: '',
    });
    const draft = methodDraftOf(manualItem);
    expect(draft).toEqual({
      methodOverride: 'MANUAL',
      manualUnitPrice: '95.5',
      manualJustification: JUSTIFICATION,
    });
    expect(methodChanged(draft, manualItem)).toBe(false);
    expect(methodChanged({ ...draft, manualUnitPrice: '95,6' }, manualItem)).toBe(true);
    expect(methodChanged({ ...draft, methodOverride: '' }, manualItem)).toBe(true);
    expect(methodChanged(methodDraftOf(priceItem(1)), priceItem(1))).toBe(false);
  });

  it('V-01/V-02 só com MANUAL; corpo do PRS-07 (vírgula vira ponto; vazio = null)', () => {
    expect(
      methodIssues({ methodOverride: 'MEAN', manualUnitPrice: '', manualJustification: '' }, 2),
    ).toEqual({});
    expect(
      methodIssues(
        { methodOverride: 'MANUAL', manualUnitPrice: '1,234', manualJustification: 'x' },
        2,
      ),
    ).toEqual({
      manualUnitPrice: 'Informe um valor válido, com até 2 casas decimais.',
      manualJustification: 'Informe o valor manual e a justificativa (mín. 20 caracteres).',
    });
    expect(
      methodBodyOf({ methodOverride: '', manualUnitPrice: '1', manualJustification: 'x' }),
    ).toEqual({
      methodOverride: null,
    });
    expect(
      methodBodyOf({
        methodOverride: 'MANUAL',
        manualUnitPrice: '9,5',
        manualJustification: ` ${JUSTIFICATION} `,
      }),
    ).toEqual({
      methodOverride: 'MANUAL',
      manualUnitPrice: '9.5',
      manualJustification: JUSTIFICATION,
    });
  });

  it('selo do método', () => {
    expect(methodBadge(priceItem(1))).toBe('AUTOMATIC');
    expect(methodBadge(priceItem(1, { methodOverride: 'LOWEST' }))).toBe('OVERRIDE');
    expect(methodBadge(manualItem)).toBe('MANUAL');
  });

  it('PRS-04: só os parâmetros alterados e erros de faixa', () => {
    const { parameters } = priceResearchDto();
    const draft = parametersDraftOf(parameters);
    expect(parametersPatchOf(draft, parameters)).toEqual({ body: {}, issues: {} });
    expect(
      parametersPatchOf(
        {
          ...draft,
          defaultMethod: 'MEDIAN',
          cvThresholdPercent: '30,5',
          minQuotations: '4',
          unitPriceDecimals: 4,
          roundingMode: 'HALF_EVEN',
        },
        parameters,
      ).body,
    ).toEqual({
      defaultMethod: 'MEDIAN',
      cvThresholdPercent: '30.5',
      minQuotations: 4,
      unitPriceDecimals: 4,
      roundingMode: 'HALF_EVEN',
    });
    expect(parametersPatchOf({ ...draft, cvThresholdPercent: '0' }, parameters).issues).toEqual({
      cvThresholdPercent: 'Informe um valor dentro da faixa permitida.',
    });
  });
});
