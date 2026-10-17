import type { ProcessItemDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  completedReferencesAffected,
  createBodyOf,
  formValuesOf,
  groupByLot,
  hasItemsWithoutLot,
  inUseReferencesOf,
  isUnitLocked,
  isUnusualKind,
  itemKindsOf,
  moveItem,
  moveTo,
  patchOf,
  sequenceGaps,
  validateItem,
} from './process-items-model';

const UNIT = '0192a000-0000-7000-8000-000000000231';
const DOC = '0192a000-0000-7000-8000-000000000501';

function item(sequence: number, extra: Partial<ProcessItemDto> = {}): ProcessItemDto {
  return {
    id: `0192a000-0000-7000-8000-${String(900 + sequence).padStart(12, '0')}`,
    processId: '0192a000-0000-7000-8000-000000000400',
    sequence,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: `Item ${String(sequence)}`,
    unitOfMeasure: { id: UNIT, label: 'Unidade' },
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity: null,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceMasked: false,
    referenceUnitPriceSourceDocumentId: null,
    references: [],
    version: 1,
    ...extra,
  };
}

describe('Aba Itens — regras de tela (US-006)', () => {
  it('agrupa por lote (com nome) e deixa "Sem lote" no fim', () => {
    const groups = groupByLot([
      item(3),
      item(2, { lotNumber: 2 }),
      item(1, { lotNumber: 1, lotName: 'Materiais' }),
      item(4, { lotNumber: 1, lotName: 'Materiais' }),
    ]);
    expect(groups.map((group) => [group.lotNumber, group.lotName, group.items.length])).toEqual([
      [1, 'Materiais', 2],
      [2, null, 1],
      [null, null, 1],
    ]);
    expect(hasItemsWithoutLot([item(1, { lotNumber: 1 }), item(2)])).toBe(true);
    expect(hasItemsWithoutLot([item(1), item(2)])).toBe(false);
  });

  it('lacunas da numeração (FA-02)', () => {
    expect(sequenceGaps([item(1), item(3)])).toEqual([1, 3]);
    expect(sequenceGaps([item(1), item(2)])).toBeNull();
  });

  it('mover por teclado e por arrasto', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    expect(moveTo(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveTo(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c']);
    expect(moveTo(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });

  it('formulário: valores, corpo do PRC-14 e PATCH só com o que mudou', () => {
    const blank = formValuesOf(null, 'SERVICE');
    expect(blank).toMatchObject({ kind: 'SERVICE', description: '', lotNumber: '' });
    expect(
      createBodyOf({ ...blank, description: 'Areia', unitOfMeasureId: UNIT, lotNumber: '2' }),
    ).toEqual({ description: 'Areia', kind: 'SERVICE', unitOfMeasureId: UNIT, lotNumber: 2 });

    const current = item(1, { lotNumber: 1, lotName: 'L', notes: 'obs' });
    const values = formValuesOf(current, null);
    expect(patchOf(current, values)).toEqual({});
    expect(patchOf(current, { ...values, notes: '', description: 'Novo item' })).toEqual({
      description: 'Novo item',
      notes: null,
    });
    expect(patchOf(current, { ...values, lotNumber: '' })).toEqual({ lotNumber: null });
  });

  it('validação com o schema da API (V-01, V-04, V-05)', () => {
    const blank = formValuesOf(null, null);
    expect(validateItem(blank)).toMatchObject({
      description: 'Descreva o item (3 a 2.000 caracteres).',
      kind: 'Selecione a natureza do item.',
      unitOfMeasureId: 'Selecione uma unidade de medida válida.',
    });
    expect(
      validateItem({
        ...blank,
        description: 'Cimento',
        kind: 'GOOD',
        unitOfMeasureId: UNIT,
        catalogSystem: 'CATMAT',
        catalogCode: 'AB12',
      }),
    ).toEqual({ catalogCode: 'O código CATMAT/CATSER deve conter apenas números.' });
  });

  it('natureza incomum (FA-05) e itemKinds do tipo', () => {
    expect(itemKindsOf({ itemKinds: ['GOOD'] })).toEqual(['GOOD']);
    expect(itemKindsOf({})).toBeNull();
    expect(isUnusualKind('WORK', ['GOOD'])).toBe(true);
    expect(isUnusualKind('GOOD', ['GOOD'])).toBe(false);
    expect(isUnusualKind('WORK', null)).toBe(false);
    expect(isUnusualKind('', ['GOOD'])).toBe(false);
  });

  it('unidade travada (FA-04), documentos concluídos afetados (FA-03) e referências do 409 (FA-01)', () => {
    const references = [
      {
        documentId: DOC,
        code: 'ETP 0003/2026',
        typeCode: 'ETP',
        status: 'APPROVED',
        editable: false,
      },
      { documentId: DOC, code: 'DFD 0005/2026', typeCode: 'DFD', status: 'DRAFT', editable: true },
    ];
    const used = item(1, { references });
    expect(isUnitLocked(used)).toBe(true);
    expect(isUnitLocked(item(2))).toBe(false);
    expect(isUnitLocked(null)).toBe(false);
    expect(completedReferencesAffected(used, { description: 'Novo' })).toEqual([references[0]]);
    expect(completedReferencesAffected(used, { notes: 'x' })).toEqual([]);

    const error = new ApiError({
      status: 409,
      code: 'ITEM_IN_USE',
      detail: 'Item em uso',
      problem: {
        type: 'about:blank',
        title: 'Item em uso',
        status: 409,
        detail: 'x',
        instance: '/x',
        code: 'ITEM_IN_USE',
        correlationId: 'c',
        errors: [],
        violations: [],
        meta: { references },
      },
    });
    expect(inUseReferencesOf(error)).toEqual(references);
  });
});
