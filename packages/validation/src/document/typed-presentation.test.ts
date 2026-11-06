import { describe, expect, it } from 'vitest';

import {
  formatDatePtBr,
  formatDecimalPtBr,
  formatMoneyPtBr,
  headerFieldsWithoutLabel,
  presentCollection,
  presentTypedHeader,
  sectionKeyLabel,
  sectionKeysWithoutLabel,
} from './typed-presentation.js';

describe('typed-presentation', () => {
  it('todo campo do cabeçalho tipado tem rótulo em pt-BR (falha se entrar chave nova sem rótulo)', () => {
    expect(headerFieldsWithoutLabel()).toEqual([]);
  });

  it('toda seção dos módulos tem título em pt-BR', () => {
    expect(sectionKeysWithoutLabel()).toEqual([]);
    expect(sectionKeyLabel('CHAVE_DESCONHECIDA')).toBe('Seção');
  });

  it('formata datas, moeda e decimais no padrão brasileiro', () => {
    expect(formatDatePtBr('2026-11-06')).toBe('06/11/2026');
    expect(formatDatePtBr('2026-11-06T10:00:00.000Z')).toBe('06/11/2026');
    expect(formatMoneyPtBr('650000.00')).toBe('R$ 650.000,00');
    expect(formatMoneyPtBr('1234.5')).toBe('R$ 1.234,50');
    expect(formatDecimalPtBr('10.0000')).toBe('10');
    expect(formatDecimalPtBr('1234.5000')).toBe('1.234,5');
  });

  it('cabeçalho do DFD: rótulos, enumerações, nomes no lugar de ids e sigilo', () => {
    const rows = presentTypedHeader('DFD', {
      requestDate: '2026-11-06',
      requestingDepartmentId: '0198f1c0-0000-7000-8000-000000000001',
      requestingDepartmentName: 'Secretaria de Saúde',
      responsibleId: '0198f1c0-0000-7000-8000-000000000002',
      responsibleName: 'Maria Souza',
      objectSummary: 'Compra de insumos',
      priority: 'URGENT',
      expectedDate: null,
      estimatedValue: null,
      estimatedValueMasked: true,
      pcaStatus: 'NOT_PLANNED',
      pcaYear: null,
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    expect(byKey.requestDate).toEqual({
      key: 'requestDate',
      label: 'Data do pedido',
      value: '06/11/2026',
    });
    expect(byKey.requestingDepartmentId?.value).toBe('Secretaria de Saúde');
    expect(byKey.responsibleId?.value).toBe('Maria Souza');
    expect(byKey.priority?.value).toBe('Urgente');
    expect(byKey.pcaStatus?.value).toBe('Não previsto no PCA');
    expect(byKey.expectedDate?.value).toBe('—');
    expect(byKey.estimatedValue?.value).toBe('Valor sigiloso');
    const text = rows.map((row) => `${row.label} ${row.value}`).join(' ');
    expect(text).not.toMatch(/0198f1c0|URGENT|NOT_PLANNED|Request|Id\b/);
  });

  it('ids sem nome resolvido saem como "—", nunca o UUID', () => {
    const rows = presentTypedHeader('TERM_OF_REFERENCE', {
      selectionCriterionId: '0198f1c0-0000-7000-8000-000000000003',
      importedFromEtpId: '0198f1c0-0000-7000-8000-000000000004',
    });
    expect(rows).toEqual([
      { key: 'selectionCriterionId', label: 'Critério de julgamento', value: '—' },
    ]);
  });

  it('TR: prazos, percentuais e booleano', () => {
    const rows = presentTypedHeader('TERM_OF_REFERENCE', {
      contractDurationMonths: 12,
      paymentTermDays: 1,
      contractGuaranteePercent: '5.00',
      allowsSubcontracting: false,
      executionDeadlineType: 'BUSINESS',
      awardType: 'BY_LOT',
    });
    const values = rows.map((row) => row.value);
    expect(values).toEqual(['12 meses', 'Dias úteis', '1 dia', '5%', 'Não', 'Por lote']);
  });

  it('coleção de itens em pt-BR, sem ids técnicos', () => {
    const table = presentCollection('items', [
      {
        processItemId: '0198f1c0-0000-7000-8000-000000000005',
        unitOfMeasureId: '0198f1c0-0000-7000-8000-000000000006',
        sequence: 1,
        lotNumber: null,
        description: 'Caneta',
        unit: 'Unidade',
        quantity: '10.0000',
        notes: null,
        sortOrder: 0,
      },
    ]);
    expect(table?.title).toBe('Itens');
    expect(table?.columns.map((column) => column.label)).toEqual([
      'Nº',
      'Descrição',
      'Unidade',
      'Quantidade',
    ]);
    expect(table?.rows).toEqual([['1', 'Caneta', 'Unidade', '10']]);
  });

  it('coleção sem dicionário não é impressa', () => {
    expect(presentCollection('coisaQualquer', [{ a: 1 }])).toBeNull();
  });
});
