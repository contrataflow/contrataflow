import type { ComparativeMapDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { readXlsx, writeXlsx } from '#shared/spreadsheet/xlsx.js';

import { comparativeMapSheet } from './comparative-map.xlsx.js';
import { maskComparativeMap } from '../domain/comparative-map.js';

/*
 * US-031 — planilha do mapa comparativo (PRS-22): a mesma matriz da tela, preços numéricos, selos
 * em "Observações", legenda das fontes e resumo; POL-09 = "Sigiloso" em toda célula monetária;
 * conteúdo determinístico (mesma entrada, mesmos bytes).
 */

const id = (n: number) => `0192d031-0000-7000-8000-${String(n).padStart(12, '0')}`;

const MAP: ComparativeMapDto = {
  priceResearchId: id(1),
  code: 'PP 0001/2026',
  title: 'Pesquisa de preços',
  referenceDate: '2026-10-06',
  lastCalculatedAt: '2026-10-06T15:30:00.000Z',
  unitPriceDecimals: 2,
  totalEstimatedValue: '1500.00',
  masked: false,
  items: [
    {
      id: id(101),
      processItemId: id(201),
      sequence: 1,
      lotNumber: null,
      description: 'Cimento CP II 50 kg',
      unitLabel: 'SC',
      quantity: '10.0000',
      sortOrder: 1,
      effectiveMethod: 'MEDIAN',
      validQuotationsCount: 2,
      meanPrice: '150.0000',
      medianPrice: '150.0000',
      lowestPrice: '100.0000',
      highestPrice: '200.0000',
      stdDeviation: '70.7107',
      coefficientOfVariation: '47.1405',
      recommendedUnitPrice: '150.00',
      totalPrice: '1500.00',
      valuesMasked: false,
      alerts: [{ code: 'HIGH_CV' }, { code: 'HAS_OUTLIERS' }],
    },
    {
      id: id(102),
      processItemId: id(202),
      sequence: 2,
      lotNumber: null,
      description: 'Areia média',
      unitLabel: 'M3',
      quantity: '12.0000',
      sortOrder: 2,
      effectiveMethod: null,
      validQuotationsCount: 0,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      coefficientOfVariation: null,
      recommendedUnitPrice: null,
      totalPrice: null,
      valuesMasked: false,
      alerts: [{ code: 'NO_VALID_QUOTES' }],
    },
  ],
  sources: [
    {
      id: id(301),
      description: 'Orçamento',
      sourceType: { code: 'PESQUISA_DIRETA_FORNECEDOR', label: 'Pesquisa direta' },
      supplierName: 'Construtora XYZ',
      quoteDate: '2026-09-30',
      sortOrder: 1,
    },
    {
      id: id(302),
      description: 'Orçamento',
      sourceType: { code: 'SITIO_ELETRONICO', label: 'Sítio eletrônico' },
      supplierName: null,
      quoteDate: null,
      sortOrder: 2,
    },
  ],
  cells: [
    {
      priceItemId: id(101),
      priceSourceId: id(301),
      quotationId: id(501),
      unitPrice: '100.0000',
      unitPriceMasked: false,
      status: 'VALID',
      exclusionReason: null,
      outlierFlag: 'NONE',
      isExpired: true,
    },
    {
      priceItemId: id(101),
      priceSourceId: id(302),
      quotationId: id(502),
      unitPrice: '200.0000',
      unitPriceMasked: false,
      status: 'VALID',
      exclusionReason: null,
      outlierFlag: 'HIGH',
      isExpired: false,
    },
    {
      priceItemId: id(102),
      priceSourceId: id(301),
      quotationId: id(503),
      unitPrice: '50.0000',
      unitPriceMasked: false,
      status: 'EXCLUDED',
      exclusionReason: 'INCONSISTENT',
      outlierFlag: 'NONE',
      isExpired: false,
    },
  ],
};

/** As linhas da planilha como texto, por coluna (vazias = ''). */
function sheet(buffer: Buffer): string[][] {
  return readXlsx(buffer, { maxRows: 10_000, maxColumns: 200 }).map((row) => {
    const width = Math.max(-1, ...row.cells.keys()) + 1;
    return Array.from({ length: width }, (_, index) => row.cells.get(index)?.text ?? '');
  });
}

describe('comparativeMapSheet (PRS-22)', () => {
  it('cabeçalho, matriz com preços numéricos, estatísticas, alertas e selos em Observações', () => {
    const file = writeXlsx(comparativeMapSheet(MAP));
    const [header, first, second] = sheet(file);
    expect(header).toEqual([
      'Item',
      'Descrição',
      'Unidade',
      'Quantidade',
      'Orçamento',
      'Orçamento (2)',
      'Cotações válidas',
      'Média',
      'Mediana',
      'Menor preço',
      'Maior preço',
      'Desvio padrão',
      'CV (%)',
      'Método',
      'Valor unitário estimado',
      'Valor total estimado',
      'Alertas',
      'Observações',
    ]);
    expect(first).toEqual([
      '1',
      'Cimento CP II 50 kg',
      'SC',
      '10.0000',
      '100.0000',
      '200.0000',
      '2',
      '150.0000',
      '150.0000',
      '100.0000',
      '200.0000',
      '70.7107',
      '47.1405',
      'Mediana',
      '150.00',
      '1500.00',
      'Preços muito dispersos; Valores atípicos',
      'Orçamento: Vencida; Orçamento (2): Acima da mediana',
    ]);
    expect(second?.slice(0, 7)).toEqual(['2', 'Areia média', 'M3', '12.0000', '50.0000', '', '0']);
    expect(second?.at(-2)).toBe('Sem cotações válidas');
    expect(second?.at(-1)).toBe('Orçamento: Desconsiderada (Inconsistente)');
  });

  it('legenda das fontes e resumo (data-base, cálculo, total)', () => {
    const rows = sheet(writeXlsx(comparativeMapSheet(MAP)));
    const legend = rows.findIndex((row) => row[0] === 'Fonte');
    expect(rows[legend + 1]).toEqual([
      'Orçamento',
      'Orçamento',
      'Pesquisa direta',
      'Construtora XYZ',
      '30/09/2026',
    ]);
    expect(rows[legend + 2]).toEqual(['Orçamento (2)', 'Orçamento', 'Sítio eletrônico']);
    expect(rows.find((row) => row[0] === 'Data-base')).toEqual(['Data-base', '06/10/2026']);
    expect(rows.find((row) => row[0] === 'Calculado em')).toEqual([
      'Calculado em',
      '06/10/2026 15:30 UTC',
    ]);
    expect(rows.find((row) => row[0] === 'Valor total estimado')).toEqual([
      'Valor total estimado',
      '1500.00',
    ]);
  });

  it('POL-09: "Sigiloso" em toda célula monetária, estatística e total; selos continuam', () => {
    const rows = sheet(writeXlsx(comparativeMapSheet(maskComparativeMap(MAP))));
    const [, first, second] = rows;
    expect(first?.slice(4, 6)).toEqual(['Sigiloso', 'Sigiloso']);
    expect(first?.slice(7, 13)).toEqual(Array(6).fill('Sigiloso'));
    expect(first?.slice(14, 16)).toEqual(['Sigiloso', 'Sigiloso']);
    expect(first?.at(-1)).toBe('Orçamento: Vencida; Orçamento (2): Acima da mediana');
    expect(second?.[4]).toBe('Sigiloso');
    expect(rows.find((row) => row[0] === 'Valor total estimado')?.[1]).toBe('Sigiloso');
    const all = rows.flat().join('|');
    for (const value of ['100.0000', '200.0000', '50.0000', '150.00', '1500.00', '47.1405']) {
      expect(all).not.toContain(value);
    }
  });

  it('sem fontes (FA-04): a mensagem no lugar das colunas', () => {
    const rows = sheet(writeXlsx(comparativeMapSheet({ ...MAP, sources: [], cells: [] })));
    expect(rows.some((row) => row[1] === 'Cadastre ao menos uma fonte para montar o mapa')).toBe(
      true,
    );
  });

  it('determinístico: a mesma entrada gera os mesmos bytes', () => {
    expect(writeXlsx(comparativeMapSheet(MAP)).equals(writeXlsx(comparativeMapSheet(MAP)))).toBe(
      true,
    );
  });

  it('4 casas decimais no preço unitário quando a pesquisa usa 4', () => {
    const input = comparativeMapSheet({ ...MAP, unitPriceDecimals: 4 });
    expect(input.rows[1]?.[4]).toEqual({ kind: 'number', value: '100.0000', style: 'decimal4' });
    expect(input.rows[1]?.[15]).toEqual({ kind: 'number', value: '1500.00', style: 'decimal2' });
  });
});
