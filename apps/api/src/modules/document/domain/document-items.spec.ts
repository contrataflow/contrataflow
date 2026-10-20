import type { RichTextDocValue } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { planDocumentItems } from './document-items.js';
import type { DocumentItem, PlanDocumentItemsInput } from './document-items.js';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const EARLIER = new Date('2026-10-16T10:00:00.000Z');
const GLOVES = '0192f014-0000-7000-8000-0000000000c1';
const SYRINGES = '0192f014-0000-7000-8000-0000000000c2';
const SOAP = '0192f014-0000-7000-8000-0000000000c3';

let sequence = 0;
const ids = () => `new-${String((sequence += 1))}`;

const existing = (processItemId: string, quantity: string, sortOrder = 0): DocumentItem => ({
  id: `row-${processItemId}`,
  tenantId: 't',
  documentId: 'doc',
  processItemId,
  quantity,
  notes: null,
  sortOrder,
  calculationMemo: null,
  specification: null,
  acceptanceCriteria: null,
  createdAt: EARLIER,
  updatedAt: EARLIER,
  createdById: 'u0',
  updatedById: 'u0',
});

function plan(overrides: Partial<PlanDocumentItemsInput>) {
  return planDocumentItems({
    tenantId: 't',
    documentId: 'doc',
    current: [],
    next: [],
    available: new Map([
      [GLOVES, { processItemId: GLOVES, allowsDecimal: false }],
      [SYRINGES, { processItemId: SYRINGES, allowsDecimal: false }],
      [SOAP, { processItemId: SOAP, allowsDecimal: true }],
    ]),
    actorId: 'u1',
    now: NOW,
    newId: ids,
    ...overrides,
  });
}

describe('planDocumentItems (RN-DFD-14 · V-09/V-10)', () => {
  it('nova coleção com 4 casas, ordem da lista e diff de inclusão', () => {
    const result = plan({
      next: [
        { processItemId: GLOVES, quantity: '120' },
        { processItemId: SOAP, quantity: '2.5', notes: '  embalagem de 1 kg ', sortOrder: 7 },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(
      result.items.map((item) => [item.processItemId, item.quantity, item.notes, item.sortOrder]),
    ).toEqual([
      [GLOVES, '120.0000', null, 0],
      [SOAP, '2.5000', 'embalagem de 1 kg', 7],
    ]);
    expect(result.items[0]).toMatchObject({ createdAt: NOW, createdById: 'u1', updatedById: 'u1' });
    expect(result.changes).toEqual([
      { processItemId: GLOVES, old: null, new: '120.0000' },
      { processItemId: SOAP, old: null, new: '2.5000' },
    ]);
  });

  it('mantém a linha existente sem mudança, reaproveita o id na alteração e registra a remoção', () => {
    const gloves = existing(GLOVES, '120.0000', 0);
    const syringes = existing(SYRINGES, '5000.0000', 1);
    const result = plan({
      current: [gloves, syringes],
      next: [
        { processItemId: GLOVES, quantity: '120.0' },
        { processItemId: SOAP, quantity: '3', sortOrder: 1 },
      ],
    });
    expect(result.items[0]).toBe(gloves);
    expect(result.changes).toEqual([
      { processItemId: SOAP, old: null, new: '3.0000' },
      { processItemId: SYRINGES, old: '5000.0000', new: null },
    ]);
    const changed = plan({
      current: [gloves],
      next: [{ processItemId: GLOVES, quantity: '60' }],
    });
    expect(changed.items[0]).toMatchObject({
      id: gloves.id,
      quantity: '60.0000',
      createdAt: EARLIER,
      createdById: 'u0',
      updatedAt: NOW,
      updatedById: 'u1',
    });
    expect(changed.changes).toEqual([{ processItemId: GLOVES, old: '120.0000', new: '60.0000' }]);
  });

  it('erros por linha: item fora do processo, repetido, quantidade inválida ou fracionária', () => {
    const result = plan({
      next: [
        { processItemId: 'outro', quantity: '1' },
        { processItemId: GLOVES, quantity: '1' },
        { processItemId: GLOVES, quantity: '2' },
        { processItemId: SYRINGES, quantity: '2.5' },
        { processItemId: SOAP, quantity: '0' },
      ],
    });
    expect(result.errors.map((error) => [error.field, error.code])).toEqual([
      ['items[0].processItemId', 'REFERENCE_NOT_FOUND'],
      ['items[2].processItemId', 'DUPLICATE_IN_LIST'],
      ['items[3].quantity', 'INVALID_DECIMAL'],
      ['items[4].quantity', 'OUT_OF_RANGE'],
    ]);
    expect(result.errors[2]?.message).toBe('Esta unidade aceita apenas números inteiros.');
  });

  it('coleção vazia remove tudo', () => {
    const result = plan({ current: [existing(GLOVES, '1.0000')], next: [] });
    expect(result.items).toEqual([]);
    expect(result.changes).toEqual([{ processItemId: GLOVES, old: '1.0000', new: null }]);
  });
});

describe('planDocumentItems — memória de cálculo do ETP (US-022 · RN-ETP-27)', () => {
  const memo = (text: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  it('grava a memória nova e a lista em memoChanges', () => {
    const result = plan({
      current: [existing(SOAP, '2.0000')],
      next: [{ processItemId: SOAP, quantity: '2', calculationMemo: memo('50 × 10') }],
    });
    expect(result.items[0]?.calculationMemo).toEqual(memo('50 × 10'));
    expect(result.items[0]?.id).toBe(`row-${SOAP}`);
    expect(result.changes).toEqual([]);
    expect(result.memoChanges).toEqual([{ processItemId: SOAP, old: null, new: memo('50 × 10') }]);
  });

  it('ausente no corpo mantém a memória gravada; null limpa', () => {
    const saved = { ...existing(SOAP, '2.0000'), calculationMemo: memo('gravada') };
    const kept = plan({ current: [saved], next: [{ processItemId: SOAP, quantity: '2' }] });
    expect(kept.items[0]).toBe(saved);
    expect(kept.memoChanges).toEqual([]);
    const cleared = plan({
      current: [saved],
      next: [{ processItemId: SOAP, quantity: '2', calculationMemo: null }],
    });
    expect(cleared.items[0]?.calculationMemo).toBeNull();
    expect(cleared.memoChanges).toEqual([{ processItemId: SOAP, old: memo('gravada'), new: null }]);
  });

  it('a mesma memória com as chaves em outra ordem (jsonb) não conta como alteração', () => {
    const saved = {
      ...existing(SOAP, '2.0000'),
      calculationMemo: { content: memo('igual').content, type: 'doc' as const },
    };
    const result = plan({
      current: [saved],
      next: [{ processItemId: SOAP, quantity: '2', calculationMemo: memo('igual') }],
    });
    expect(result.items[0]).toBe(saved);
    expect(result.memoChanges).toEqual([]);
  });
});

describe('planDocumentItems — especificação e critérios de aceitação do TR (US-038 · RN-TR-26)', () => {
  const spec: RichTextDocValue = { type: 'doc', content: [{ type: 'paragraph' }] };
  const criteria: RichTextDocValue = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Laudo' }] }],
  };

  it('grava os textos novos e os lista em textChanges', () => {
    const result = plan({
      next: [
        { processItemId: GLOVES, quantity: '1', specification: spec, acceptanceCriteria: criteria },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({ specification: spec, acceptanceCriteria: criteria });
    expect(result.textChanges).toEqual([
      { processItemId: GLOVES, field: 'specification', old: null, new: spec },
      { processItemId: GLOVES, field: 'acceptanceCriteria', old: null, new: criteria },
    ]);
  });

  it('ausente no corpo mantém o texto gravado (linha intacta); null limpa', () => {
    const current = {
      ...existing(GLOVES, '1.0000'),
      specification: spec,
      acceptanceCriteria: criteria,
    };
    const kept = plan({
      current: [current],
      next: [{ processItemId: GLOVES, quantity: '1', sortOrder: 0 }],
    });
    expect(kept.items[0]).toBe(current);
    expect(kept.textChanges).toEqual([]);

    const cleared = plan({
      current: [current],
      next: [{ processItemId: GLOVES, quantity: '1', sortOrder: 0, specification: null }],
    });
    expect(cleared.items[0]).toMatchObject({ specification: null, acceptanceCriteria: criteria });
    expect(cleared.textChanges).toEqual([
      { processItemId: GLOVES, field: 'specification', old: spec, new: null },
    ]);
  });

  it('teto das observações por tipo: 1.000 por padrão e 5.000 no TR', () => {
    const line = { processItemId: GLOVES, quantity: '1', notes: 'x'.repeat(1001) };
    expect(plan({ next: [line] }).errors).toEqual([
      expect.objectContaining({ field: 'items[0].notes', code: 'TOO_LONG' }),
    ]);
    expect(plan({ next: [line], notesMax: 5000 }).errors).toEqual([]);
    expect(plan({ next: [{ ...line, notes: 'x'.repeat(5001) }], notesMax: 5000 }).errors).toEqual([
      expect.objectContaining({
        field: 'items[0].notes',
        code: 'TOO_LONG',
        message: 'As observações do item devem ter no máximo 5.000 caracteres.',
      }),
    ]);
  });

  it('item repetido: DUPLICATE_IN_LIST com "Este item já está na lista."', () => {
    const result = plan({
      next: [
        { processItemId: GLOVES, quantity: '1' },
        { processItemId: GLOVES, quantity: '2' },
      ],
    });
    expect(result.errors).toEqual([
      {
        field: 'items[1].processItemId',
        code: 'DUPLICATE_IN_LIST',
        message: 'Este item já está na lista.',
      },
    ]);
  });
});
