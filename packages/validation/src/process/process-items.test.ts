import { describe, expect, it } from 'vitest';

import { ProcessItemsChanged } from './events.js';
import {
  createProcessItemSchema,
  hasSequenceGaps,
  isValidCatalogCode,
  processItemIssues,
  reorderProcessItemsSchema,
  updateProcessItemSchema,
} from './process-items.js';

const UNIT = '0192f000-0000-7000-8000-0000000000c1';

const valid = { description: '  Cimento CP-II 50 kg ', kind: 'GOOD', unitOfMeasureId: UNIT };

const issuesOf = (result: {
  success: boolean;
  error?: { issues: readonly { path: PropertyKey[]; message: string }[] };
}) => (result.error?.issues ?? []).map((issue) => [issue.path.join('.'), issue.message]);

describe('createProcessItemSchema (US-006 · PRC-14)', () => {
  it('aceita o mínimo, apara a descrição e trata textos vazios como não informados', () => {
    expect(createProcessItemSchema.parse({ ...valid, notes: '  ', lotName: '' })).toEqual({
      description: 'Cimento CP-II 50 kg',
      kind: 'GOOD',
      unitOfMeasureId: UNIT,
      notes: null,
      lotName: null,
    });
  });

  it('V-01/V-02/V-06: descrição, natureza e lote fora da faixa', () => {
    const result = createProcessItemSchema.safeParse({
      description: 'ab',
      kind: 'FOOD',
      unitOfMeasureId: UNIT,
      lotNumber: 0,
    });
    expect(issuesOf(result)).toEqual([
      ['description', 'Descreva o item (3 a 2.000 caracteres).'],
      ['kind', 'Selecione a natureza do item.'],
      ['lotNumber', 'Informe um lote entre 1 e 999.'],
    ]);
  });

  it('V-04/V-05: regras cruzadas do lote e do código de catálogo', () => {
    expect(
      issuesOf(createProcessItemSchema.safeParse({ ...valid, lotName: 'L', catalogCode: '1' })),
    ).toEqual([
      ['lotNumber', 'Informe o número do lote.'],
      ['catalogSystem', 'Informe o sistema do código.'],
    ]);
    expect(
      issuesOf(
        createProcessItemSchema.safeParse({ ...valid, catalogSystem: 'CATSER', catalogCode: 'X1' }),
      ),
    ).toEqual([['catalogCode', 'O código CATMAT/CATSER deve conter apenas números.']]);
  });

  it('V-07: campos de referência e número são somente leitura (chave desconhecida)', () => {
    const result = createProcessItemSchema.safeParse({ ...valid, referenceUnitPrice: '1.0000' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('updateProcessItemSchema (PRC-15)', () => {
  it('parcial: só os campos enviados; null limpa', () => {
    expect(updateProcessItemSchema.parse({ notes: null })).toEqual({ notes: null });
    expect(updateProcessItemSchema.safeParse({ sequence: 2 }).success).toBe(false);
  });
});

describe('reorderProcessItemsSchema (PRC-17)', () => {
  it('lista de uuids', () => {
    expect(reorderProcessItemsSchema.parse({ itemIds: [UNIT] })).toEqual({ itemIds: [UNIT] });
    expect(reorderProcessItemsSchema.safeParse({ itemIds: ['x'] }).success).toBe(false);
  });
});

describe('Regras puras', () => {
  it('CatalogCode por sistema (RN-PROC-77)', () => {
    expect(isValidCatalogCode('CATMAT', '123456')).toBe(true);
    expect(isValidCatalogCode('CATMAT', '12a')).toBe(false);
    expect(isValidCatalogCode('OTHER', 'ABC-1.2/3')).toBe(true);
    expect(isValidCatalogCode('OTHER', 'A B')).toBe(false);
    expect(isValidCatalogCode('CATSER', '1'.repeat(31))).toBe(false);
  });

  it('processItemIssues sem problemas', () => {
    expect(
      processItemIssues({ lotNumber: 1, lotName: 'L', catalogSystem: 'OTHER', catalogCode: 'X' }),
    ).toEqual([]);
  });

  it('lacunas na numeração (FA-02)', () => {
    expect(hasSequenceGaps([1, 2, 3])).toBe(false);
    expect(hasSequenceGaps([3, 1])).toBe(true);
    expect(hasSequenceGaps([])).toBe(false);
  });

  it('ProcessItemsChanged: só ids e o total', () => {
    const payload = { added: [UNIT], updated: [], removed: [], itemsCount: 1 };
    expect(ProcessItemsChanged.resolve(payload).routingKey).toBe('process.items_changed');
    expect(() => ProcessItemsChanged.resolve({ ...payload, description: 'x' })).toThrow();
  });
});
