import { describe, expect, it } from 'vitest';

import type { Quotation } from './price-source.js';
import {
  cellPriceText,
  importTemplateMatrix,
  normalizeHeader,
  planImportApplication,
  planQuotationImport,
  sequenceOf,
  sourceHeaders,
} from './quotation-import.js';
import type { ImportItemRef, ImportSourceRef, SheetCell, SheetRow } from './quotation-import.js';

/*
 * US-028 — domínio da importação por planilha: cabeçalhos (RN-PRICE-35 · FA-02), leitura célula a
 * célula (RN-PRICE-36/37 · V-03..V-05), aviso de cotação desconsiderada (RN-PRICE-39) e o plano da
 * aplicação sobre as cotações vigentes (RN-PRICE-38 · "[Concorrência]").
 */

const id = (n: number) => `0192d028-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ITEMS: ImportItemRef[] = [
  { priceItemId: id(1), sequence: 1, description: 'Cimento', unitLabel: 'SC' },
  { priceItemId: id(2), sequence: 2, description: 'Areia', unitLabel: 'M3' },
  { priceItemId: id(3), sequence: 3, description: 'Brita', unitLabel: 'M3' },
];
const SOURCES: ImportSourceRef[] = [
  { id: id(11), description: 'Painel de Preços' },
  { id: id(12), description: 'Orçamento Construtora XYZ' },
];

const t = (text: string): SheetCell => ({ kind: 'text', text });
const n = (text: string): SheetCell => ({ kind: 'number', text });
const row = (number: number, cells: readonly (SheetCell | null)[]): SheetRow => ({
  row: number,
  cells: new Map(cells.flatMap((cell, index) => (cell === null ? [] : [[index, cell] as const]))),
});
const HEADER = row(1, [
  t('Item'),
  t('Descrição do item'),
  t('Unidade'),
  t('Painel de Preços'),
  t('Orçamento Construtora XYZ'),
]);

function quotation(overrides: Partial<Quotation>): Quotation {
  const now = new Date('2026-10-06T15:00:00.000Z');
  return {
    id: id(99),
    tenantId: id(100),
    priceResearchId: id(101),
    priceItemId: id(1),
    priceSourceId: id(11),
    unitPrice: '150.0000',
    brandModel: null,
    status: 'VALID',
    exclusionReason: null,
    exclusionJustification: null,
    excludedById: null,
    excludedAt: null,
    outlierFlag: 'NONE',
    isExpired: false,
    notes: null,
    createdAt: now,
    updatedAt: now,
    createdById: null,
    updatedById: null,
    version: 1,
    ...overrides,
  };
}

const plan = (
  rows: readonly SheetRow[],
  quotations: readonly Quotation[] = [],
  decimals: 2 | 4 = 2,
) =>
  planQuotationImport({
    rows,
    items: ITEMS,
    sources: SOURCES,
    quotations,
    unitPriceDecimals: decimals,
  });

function ok(result: ReturnType<typeof plan>) {
  if (result.kind !== 'ok') throw new Error(`esperava ok, veio ${result.problem}`);
  return result;
}

describe('cabeçalhos', () => {
  it('normaliza acento, caixa e espaços; descrições repetidas ganham o ordinal', () => {
    expect(normalizeHeader('  Descrição\n do   ITEM ')).toBe('descricao do item');
    expect(
      sourceHeaders([
        { id: 'a', description: 'Painel' },
        { id: 'b', description: 'Outra' },
        { id: 'c', description: ' painel ' },
      ]),
    ).toEqual([
      { sourceId: 'a', header: 'Painel (1)' },
      { sourceId: 'b', header: 'Outra' },
      { sourceId: 'c', header: 'painel (2)' },
    ]);
  });
});

describe('importTemplateMatrix (PRS-24 · RN-PRICE-35)', () => {
  it('colunas fixas + uma por fonte; itens pela sequência; preços atuais nas casas da pesquisa', () => {
    const matrix = importTemplateMatrix({
      items: [...ITEMS].reverse(),
      sources: SOURCES,
      quotations: [
        quotation({ priceItemId: id(1), priceSourceId: id(12), unitPrice: '150.5000' }),
        quotation({ priceItemId: id(3), priceSourceId: id(11), unitPrice: '9.1234' }),
      ],
      unitPriceDecimals: 4,
    });
    expect(matrix.headers).toEqual([
      'Item',
      'Descrição do item',
      'Unidade',
      'Painel de Preços',
      'Orçamento Construtora XYZ',
    ]);
    expect(matrix.rows).toEqual([
      { sequence: 1, description: 'Cimento', unitLabel: 'SC', prices: [null, '150.5000'] },
      { sequence: 2, description: 'Areia', unitLabel: 'M3', prices: [null, null] },
      { sequence: 3, description: 'Brita', unitLabel: 'M3', prices: ['9.1234', null] },
    ]);
  });
});

describe('células', () => {
  it('sequência: inteiro positivo em número ou texto', () => {
    expect(sequenceOf(n('3'))).toBe(3);
    expect(sequenceOf(t(' 12 '))).toBe(12);
    for (const cell of [n('1.5'), n('0'), n('-1'), n('abc'), t('1a'), t('0'), undefined]) {
      expect(sequenceOf(cell)).toBeNull();
    }
    expect(sequenceOf({ kind: 'boolean', text: '1' })).toBeNull();
  });

  it('preço: ruído de ponto flutuante, notação científica, R$ e vírgula decimal', () => {
    expect(cellPriceText(n('150.24999999999997'))).toBe('150.25');
    expect(cellPriceText(n('1.5E-2'))).toBe('0.015');
    expect(cellPriceText(n('x'))).toBeNull();
    expect(cellPriceText(t('R$ 1.234,56'))).toBe('1234.56');
    expect(cellPriceText(t('10,5'))).toBe('10.5');
    expect(cellPriceText(t('-10'))).toBe('-10');
    expect(cellPriceText({ kind: 'boolean', text: '1' })).toBeNull();
    expect(cellPriceText({ kind: 'error', text: '#N/A' })).toBeNull();
  });
});

describe('planQuotationImport (PRS-18 · RN-PRICE-36/37)', () => {
  it('[Sucesso] 3 itens × 2 fontes válidos → 6 células válidas, nenhum erro', () => {
    const result = ok(
      plan([
        HEADER,
        row(2, [n('1'), t('Cimento'), t('SC'), n('150'), n('148.9')]),
        row(3, [n('2'), null, null, t('80,00'), n('79')]),
        row(4, [t('3'), null, null, n('45.5'), n('44.99')]),
      ]),
    );
    expect(result.summary).toEqual({
      total: 6,
      valid: 6,
      errors: 0,
      empty: 0,
      warnings: 0,
      rows: 3,
    });
    expect(result.cells).toContainEqual({
      priceItemId: id(2),
      priceSourceId: id(11),
      unitPrice: '80.0000',
    });
    expect(result.cells).toHaveLength(6);
    expect(result.columnIssues).toEqual([]);
    expect(result.columns.map((column) => [column.column, column.priceSourceId])).toEqual([
      ['D', id(11)],
      ['E', id(12)],
    ]);
  });

  it('[Sucesso] células vazias não entram (4 de 6)', () => {
    const result = ok(
      plan([
        HEADER,
        row(2, [n('1'), null, null, n('150'), null]),
        row(3, [n('2'), null, null, null, n('79')]),
        row(4, [n('3'), null, null, n('45'), n('44')]),
      ]),
    );
    expect(result.summary).toMatchObject({ total: 6, valid: 4, empty: 2, errors: 0 });
    expect(result.cells).toHaveLength(4);
  });

  it('[Validação] "-10", zero, casas demais, texto e booleano → INVALID_DECIMAL na célula', () => {
    const result = ok(
      plan([
        HEADER,
        row(2, [n('1'), null, null, n('-10'), n('0')]),
        row(3, [n('2'), null, null, n('1.234'), t('abc')]),
        row(4, [n('3'), null, null, { kind: 'boolean', text: '1' }, n('10')]),
      ]),
    );
    expect(result.summary).toMatchObject({ valid: 1, errors: 5 });
    expect(result.rows[0]?.issues[0]).toEqual({
      severity: 'ERROR',
      code: 'INVALID_DECIMAL',
      row: 2,
      column: 'D',
      header: 'Painel de Preços',
      priceSourceId: id(11),
      message: "Linha 2, fonte 'Painel de Preços': preço inválido.",
    });
    expect(result.cells).toEqual([
      { priceItemId: id(3), priceSourceId: id(12), unitPrice: '10.0000' },
    ]);
    // Com 4 casas, "1.234" é válido.
    expect(ok(plan([HEADER, row(2, [n('1'), null, null, n('1.234')])], [], 4)).summary.valid).toBe(
      1,
    );
  });

  it('V-03: item não encontrado ou repetido → erro da linha inteira; linha só com anotação é ignorada', () => {
    const result = ok(
      plan([
        HEADER,
        row(2, [n('9'), null, null, n('10'), n('11')]),
        row(3, [n('1'), null, null, n('10'), null]),
        row(4, [n('1'), null, null, n('12'), n('13')]),
        row(5, [null, null, null, n('10')]),
        row(6, [null, t('Total geral'), null, null, null]),
      ]),
    );
    expect(
      result.rows.map((entry) => [
        entry.row,
        entry.errors,
        entry.issues.map((issue) => issue.code),
      ]),
    ).toEqual([
      [2, 2, ['REFERENCE_NOT_FOUND']],
      [3, 0, []],
      [4, 2, ['DUPLICATE_IN_LIST']],
      [5, 1, ['REFERENCE_NOT_FOUND']],
    ]);
    expect(result.rows[0]?.issues[0]?.message).toBe('Linha 2: item não encontrado nesta pesquisa.');
    expect(result.summary).toMatchObject({ rows: 4, valid: 1, errors: 5 });
  });

  it('FA-02: colunas reordenadas/renomeadas pelo cabeçalho; desconhecida = aviso; repetida = aviso', () => {
    const result = ok(
      plan([
        row(3, [
          t(' orçamento construtora xyz '),
          t('Observação'),
          t('SEQUÊNCIA'),
          t('Painel de Preços'),
          t('Painel de preços'),
        ]),
        row(4, [n('7'), t('qualquer'), n('2'), n('20'), n('99')]),
      ]),
    );
    expect(result.cells).toEqual([
      { priceItemId: id(2), priceSourceId: id(12), unitPrice: '7.0000' },
      { priceItemId: id(2), priceSourceId: id(11), unitPrice: '20.0000' },
    ]);
    expect(result.columnIssues.map((issue) => [issue.column, issue.severity, issue.code])).toEqual([
      ['B', 'WARNING', 'REFERENCE_NOT_FOUND'],
      ['E', 'WARNING', 'REFERENCE_NOT_FOUND'],
    ]);
    expect(result.columnIssues[0]?.message).toBe(
      "Coluna 'Observação': fonte não encontrada nesta pesquisa. A coluna foi ignorada.",
    );
  });

  it('RN-PRICE-39: célula sobre cotação EXCLUDED → aviso, fora das células', () => {
    const result = ok(
      plan(
        [HEADER, row(2, [n('1'), null, null, n('10'), n('11')])],
        [quotation({ priceItemId: id(1), priceSourceId: id(11), status: 'EXCLUDED' })],
      ),
    );
    expect(result.summary).toMatchObject({ valid: 1, warnings: 1, errors: 0 });
    expect(result.rows[0]?.issues[0]).toMatchObject({
      severity: 'WARNING',
      code: 'QUOTATION_EXCLUDED',
    });
    expect(result.cells).toEqual([
      { priceItemId: id(1), priceSourceId: id(12), unitPrice: '11.0000' },
    ]);
  });

  it('RN-PRICE-36: sem coluna de item, sem coluna de fonte ou planilha vazia → estrutura inválida', () => {
    expect(plan([])).toEqual({ kind: 'invalid', problem: 'NO_ITEM_COLUMN' });
    expect(plan([row(1, [t('Painel de Preços')]), row(2, [n('1')])])).toEqual({
      kind: 'invalid',
      problem: 'NO_ITEM_COLUMN',
    });
    expect(plan([row(1, [t('Item'), t('Outra fonte')])])).toEqual({
      kind: 'invalid',
      problem: 'NO_SOURCE_COLUMN',
    });
  });

  it('acima de 50 colunas de fonte → TOO_MANY_SOURCES', () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      id: id(200 + index),
      description: `F${String(index)}`,
    }));
    expect(
      planQuotationImport({
        rows: [row(1, [t('Item'), ...many.map((source) => t(source.description))])],
        items: ITEMS,
        sources: many,
        quotations: [],
        unitPriceDecimals: 2,
      }),
    ).toEqual({ kind: 'invalid', problem: 'TOO_MANY_SOURCES' });
  });
});

describe('planImportApplication (PRS-19 · RN-PRICE-38/39 · [Concorrência])', () => {
  it('cria, atualiza a VALID e ignora EXCLUDED, preço igual, repetida e referência removida', () => {
    const edited = quotation({
      priceItemId: id(1),
      priceSourceId: id(11),
      unitPrice: '155.0000',
      version: 3,
    });
    const same = quotation({
      id: id(98),
      priceItemId: id(2),
      priceSourceId: id(11),
      unitPrice: '80.0000',
    });
    const excluded = quotation({
      id: id(97),
      priceItemId: id(3),
      priceSourceId: id(11),
      status: 'EXCLUDED',
    });
    const result = planImportApplication({
      cells: [
        { priceItemId: id(1), priceSourceId: id(11), unitPrice: '150.0000' },
        { priceItemId: id(1), priceSourceId: id(11), unitPrice: '151.0000' },
        { priceItemId: id(2), priceSourceId: id(11), unitPrice: '80.0000' },
        { priceItemId: id(3), priceSourceId: id(11), unitPrice: '45.0000' },
        { priceItemId: id(1), priceSourceId: id(12), unitPrice: '149.0000' },
        { priceItemId: id(4), priceSourceId: id(12), unitPrice: '1.0000' },
        { priceItemId: id(2), priceSourceId: id(13), unitPrice: '1.0000' },
      ],
      itemIds: new Set([id(1), id(2), id(3)]),
      sourceIds: new Set([id(11), id(12)]),
      quotations: [edited, same, excluded],
    });
    expect(result.creates).toEqual([
      { priceItemId: id(1), priceSourceId: id(12), unitPrice: '149.0000' },
    ]);
    expect(result.updates).toEqual([
      {
        cell: { priceItemId: id(1), priceSourceId: id(11), unitPrice: '150.0000' },
        existing: edited,
      },
    ]);
    expect(result.unchanged).toBe(5);
  });
});
