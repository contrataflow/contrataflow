import type { DocumentItemDto, ProcessItemDto, Violation } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  DFD_STEP_SLUGS,
  canEditDfd,
  departmentsOfSecretariat,
  displayQuantity,
  fieldAnchor,
  itemRows,
  itemsPayload,
  mergeItemEdits,
  raisesProcessPriority,
  rowQuantityError,
  stepFromSlug,
  violationsByStep,
} from './dfd-model';

const ID = (n: number) => `0192a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CX = ID(901);
const UN = ID(902);
const KG = ID(903);

function processItem(n: number, unit: string, extra: Partial<ProcessItemDto> = {}): ProcessItemDto {
  return {
    id: ID(n),
    processId: ID(1),
    sequence: n,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: `Item ${String(n)}`,
    unitOfMeasure: { id: unit, label: unit === CX ? 'Caixa' : 'Unidade' },
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

function documentItem(n: number, quantity: string, allowsDecimal = false): DocumentItemDto {
  return {
    processItemId: ID(n),
    sequence: n,
    description: `Item ${String(n)}`,
    unit: { id: CX, label: 'Caixa', allowsDecimal },
    quantity,
    notes: null,
    sortOrder: 0,
  };
}

const violation = (code: string, location: Partial<Violation>): Violation => ({
  code,
  severity: 'BLOCKING',
  message: code,
  ruleId: null,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
  ...location,
});

describe('passos e ?passo= (SCR-007)', () => {
  it('slug ↔ passo', () => {
    expect(DFD_STEP_SLUGS.PLANNING).toBe('planejamento');
    expect(stepFromSlug('revisao')).toBe('REVIEW');
    expect(stepFromSlug('x')).toBeNull();
    expect(stepFromSlug(null)).toBeNull();
  });

  it('edição pela API e dica de prioridade (US-017)', () => {
    expect(canEditDfd(['UPDATE', 'DELETE'])).toBe(true);
    expect(canEditDfd([])).toBe(false);
    expect(raisesProcessPriority('HIGH', 'MEDIUM')).toBe(true);
    expect(raisesProcessPriority('LOW', 'MEDIUM')).toBe(false);
    expect(raisesProcessPriority(null, 'LOW')).toBe(false);
  });
});

describe('grade de itens (RN-DFD-14 · FA-10/11)', () => {
  const units = new Map([
    [CX, false],
    [KG, true],
  ]);

  it('itens do processo por número, inclusão e quantidade do DFD ou sugestão do processo', () => {
    const rows = itemRows(
      [
        processItem(2, UN, { referenceQuantity: '5000.0000' }),
        processItem(1, CX),
        processItem(3, KG),
      ],
      [documentItem(1, '120.0000')],
      units,
    );
    expect(
      rows.map((row) => [row.sequence, row.included, row.quantity, row.allowsDecimal]),
    ).toEqual([
      [1, true, '120', false],
      [2, false, '5000', true],
      [3, false, '', true],
    ]);
  });

  it('erro de quantidade só nas linhas incluídas e payload só com elas', () => {
    const rows = itemRows([processItem(1, CX), processItem(2, CX)], [], units).map((row, index) =>
      index === 0 ? { ...row, included: true, quantity: '2.5' } : row,
    );
    const [first, second] = rows;
    if (!first || !second) throw new Error('linhas ausentes');
    expect(rowQuantityError(first)).toBe('Esta unidade aceita apenas números inteiros.');
    expect(rowQuantityError(second)).toBeNull();
    expect(itemsPayload(rows)).toEqual([{ processItemId: ID(1), quantity: '2.5' }]);
  });

  it('displayQuantity remove os zeros das 4 casas', () => {
    expect(displayQuantity('120.0000')).toBe('120');
    expect(displayQuantity('2.5000')).toBe('2.5');
    expect(displayQuantity('40')).toBe('40');
    expect(displayQuantity(null)).toBe('');
  });

  it('merge depois do 412: reaplica só as edições locais e preserva as do outro editor', () => {
    const server = [documentItem(1, '60.0000'), documentItem(3, '7.0000')];
    expect(
      mergeItemEdits(server, [
        { processItemId: ID(2), included: true, quantity: ' 5000 ' },
        { processItemId: ID(3), included: false, quantity: '' },
      ]),
    ).toEqual([
      { processItemId: ID(1), quantity: '60' },
      { processItemId: ID(2), quantity: '5000' },
    ]);
  });
});

describe('checklist da revisão (RN-DFD-19)', () => {
  it('agrupa por passo na ordem do wizard, bloqueantes e avisos separados', () => {
    const groups = violationsByStep([
      violation('DFD_ITEMS_REQUIRED', { field: 'items' }),
      violation('SECTION_REQUIRED', { sectionKey: 'JUSTIFICATION' }),
      violation('DFD_ATTACHMENTS_PENDING', { field: 'attachments', severity: 'WARNING' }),
      violation('FIELD_REQUIRED', { field: 'responsibleId' }),
    ]);
    expect(
      groups.map((group) => [group.step, group.blocking.length, group.warnings.length]),
    ).toEqual([
      ['IDENTIFICATION', 1, 0],
      ['JUSTIFICATION', 1, 1],
      ['PLANNING', 1, 0],
    ]);
  });

  it('âncora do "Ir para o campo"', () => {
    expect(fieldAnchor({ field: 'items', sectionKey: null })).toBe('dfd-field-items');
    expect(fieldAnchor({ field: null, sectionKey: 'JUSTIFICATION' })).toBe(
      'dfd-section-JUSTIFICATION',
    );
    expect(fieldAnchor({ field: null, sectionKey: null })).toBe('dfd-field-items');
  });
});

describe('setor da secretaria solicitante (RN-DFD-09)', () => {
  it('unidades ativas da subárvore', () => {
    const departments = [
      { id: 'a', path: '/sec/', isActive: true },
      { id: 'b', path: '/sec/b/', isActive: true },
      { id: 'c', path: '/sec/c/', isActive: false },
      { id: 'd', path: '/outra/d/', isActive: true },
    ];
    expect(departmentsOfSecretariat(departments, 'sec').map((item) => item.id)).toEqual(['a', 'b']);
  });
});
