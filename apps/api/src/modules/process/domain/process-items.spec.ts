import { describe, expect, it } from 'vitest';

import {
  diffItem,
  itemLimitIssues,
  itemRuleIssues,
  itemsNotEditableMessage,
  newProcessItem,
  nextSequence,
  patchedItem,
  reorderIssues,
  resequence,
  resolveLot,
  touchItem,
} from './process-items.js';
import type { ProcessItem } from './process-items.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');

function item(fields: Partial<ProcessItem> = {}): ProcessItem {
  return {
    id: `item-${String(fields.sequence ?? 1)}`,
    tenantId: 't',
    processId: 'p',
    sequence: 1,
    lotNumber: null,
    lotName: null,
    kind: 'GOOD',
    description: 'Cimento CP-II 50 kg',
    unitOfMeasureId: 'saco',
    catalogSystem: null,
    catalogCode: null,
    notes: null,
    referenceQuantity: null,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceSourceDocumentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: 'ana',
    updatedById: 'ana',
    version: 1,
    ...fields,
  };
}

describe('Itens da contratação — domínio (US-006)', () => {
  describe('Numeração (RN-PROC-73)', () => {
    it('primeiro item = 1; depois máximo + 1, mesmo com lacunas', () => {
      expect(nextSequence([])).toBe(1);
      expect(nextSequence([item({ sequence: 1 }), item({ sequence: 2 })])).toBe(3);
      expect(nextSequence([item({ sequence: 1 }), item({ sequence: 4 })])).toBe(5);
    });
  });

  describe('Limite (RN-PROC-83)', () => {
    it('999 ativos aceitam mais um; 1.000 recusam com OUT_OF_RANGE', () => {
      expect(itemLimitIssues(999)).toEqual([]);
      expect(itemLimitIssues(1000)).toEqual([
        {
          field: 'description',
          code: 'OUT_OF_RANGE',
          message: 'O processo atingiu o limite de 1.000 itens.',
        },
      ]);
    });
  });

  describe('LotNamePolicy (RN-PROC-75)', () => {
    const lot = [
      item({ id: 'a', sequence: 1, lotNumber: 1, lotName: 'Materiais' }),
      item({ id: 'b', sequence: 2, lotNumber: 1, lotName: 'Materiais' }),
      item({ id: 'c', sequence: 3, lotNumber: 2, lotName: null }),
    ];

    it('sem lote: sem nome, ninguém renomeado', () => {
      expect(resolveLot(lot, null, 'Ignorado')).toEqual({ lotName: null, renamed: [] });
    });

    it('nome não informado herda o do lote existente', () => {
      expect(resolveLot(lot, 1, undefined)).toEqual({ lotName: 'Materiais', renamed: [] });
    });

    it('lote novo sem nome: nulo; lote atual mantido sem nome informado: mantém o atual', () => {
      expect(resolveLot(lot, 5, undefined)).toEqual({ lotName: null, renamed: [] });
      expect(resolveLot([], 7, undefined, { lotNumber: 7, lotName: 'Só eu' })).toEqual({
        lotName: 'Só eu',
        renamed: [],
      });
    });

    it('nome diferente renomeia os demais itens do lote; igual não renomeia', () => {
      const renamed = resolveLot(lot, 1, 'Construção');
      expect(renamed.lotName).toBe('Construção');
      expect(renamed.renamed.map((other) => other.id)).toEqual(['a', 'b']);
      expect(resolveLot(lot, 1, 'Materiais').renamed).toEqual([]);
      // `null` explícito limpa o nome do lote inteiro.
      expect(resolveLot(lot, 1, null).renamed.map((other) => other.id)).toEqual(['a', 'b']);
      // Lote existente sem nome herda nulo.
      expect(resolveLot(lot, 2, undefined)).toEqual({ lotName: null, renamed: [] });
    });
  });

  describe('Regras cruzadas (RN-PROC-75/77)', () => {
    it('nome de lote sem número, código sem sistema e formato do código por sistema', () => {
      expect(itemRuleIssues({ lotName: 'X', catalogCode: '12' })).toEqual([
        { field: 'lotNumber', code: 'CONDITIONAL_REQUIRED', message: 'Informe o número do lote.' },
        {
          field: 'catalogSystem',
          code: 'CONDITIONAL_REQUIRED',
          message: 'Informe o sistema do código.',
        },
      ]);
      expect(itemRuleIssues({ catalogSystem: 'CATMAT', catalogCode: 'AB12' })).toEqual([
        {
          field: 'catalogCode',
          code: 'INVALID_FORMAT',
          message: 'O código CATMAT/CATSER deve conter apenas números.',
        },
      ]);
      expect(itemRuleIssues({ catalogSystem: 'OTHER', catalogCode: 'A B' })[0]?.code).toBe(
        'INVALID_FORMAT',
      );
      expect(itemRuleIssues({ catalogSystem: 'CATSER', catalogCode: '4471' })).toEqual([]);
      expect(itemRuleIssues({ catalogSystem: 'OTHER', catalogCode: 'MAT-1.2/3' })).toEqual([]);
      expect(itemRuleIssues({ lotNumber: 1, lotName: 'X' })).toEqual([]);
    });
  });

  describe('Criação, PATCH e diff', () => {
    it('item novo: versão 1, sem valores de referência; sem lote = sem nome', () => {
      const created = newProcessItem(
        { description: 'Areia média', kind: 'GOOD', unitOfMeasureId: 'm3', lotName: 'Ignorado' },
        {
          id: 'n',
          tenantId: 't',
          processId: 'p',
          sequence: 2,
          lotName: 'X',
          now: NOW,
          userId: 'ana',
        },
      );
      expect(created).toMatchObject({
        id: 'n',
        sequence: 2,
        lotNumber: null,
        lotName: null,
        catalogSystem: null,
        notes: null,
        referenceQuantity: null,
        referenceUnitPrice: null,
        version: 1,
      });
      const lotted = newProcessItem(
        { description: 'Areia média', kind: 'GOOD', unitOfMeasureId: 'm3', lotNumber: 1 },
        {
          id: 'n',
          tenantId: 't',
          processId: 'p',
          sequence: 2,
          lotName: 'Lote',
          now: NOW,
          userId: 'ana',
        },
      );
      expect(lotted).toMatchObject({ lotNumber: 1, lotName: 'Lote' });
    });

    it('PATCH: ausente mantém, null limpa; tirar o lote limpa o nome', () => {
      const current = item({
        lotNumber: 1,
        lotName: 'L',
        notes: 'obs',
        catalogSystem: 'CATMAT',
        catalogCode: '1',
      });
      expect(patchedItem(current, { notes: null })).toMatchObject({
        notes: null,
        lotNumber: 1,
        lotName: 'L',
        catalogCode: '1',
      });
      expect(patchedItem(current, { lotNumber: null })).toMatchObject({
        lotNumber: null,
        lotName: null,
      });
      expect(patchedItem(current, { description: 'Novo', kind: 'SERVICE' })).toMatchObject({
        description: 'Novo',
        kind: 'SERVICE',
      });
    });

    it('diff na ordem canônica; criação lista só os campos preenchidos', () => {
      const before = item();
      const after = { ...before, description: 'Outro', notes: 'n', lotNumber: 2 };
      expect(diffItem(before, after).map((change) => change.field)).toEqual([
        'lotNumber',
        'description',
        'notes',
      ]);
      expect(diffItem(before, before)).toEqual([]);
      expect(diffItem(null, before).map((change) => change.field)).toEqual([
        'kind',
        'description',
        'unitOfMeasureId',
      ]);
    });

    it('touchItem: nova versão e autoria', () => {
      expect(touchItem(item(), new Date('2026-10-06T00:00:00Z'), 'carla')).toMatchObject({
        version: 2,
        updatedById: 'carla',
        updatedAt: new Date('2026-10-06T00:00:00Z'),
      });
    });
  });

  describe('Reordenação (RN-PROC-74)', () => {
    const active = [
      item({ id: 'a', sequence: 1 }),
      item({ id: 'b', sequence: 3 }),
      item({ id: 'c', sequence: 4 }),
    ];

    it('lista válida: sem erros; só os números que mudam', () => {
      expect(reorderIssues(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([]);
      expect(resequence(active, ['a', 'b', 'c'])).toEqual([
        { id: 'b', from: 3, to: 2 },
        { id: 'c', from: 4, to: 3 },
      ]);
      expect(resequence(active.slice(0, 1), ['a'])).toEqual([]);
    });

    it('repetido, inexistente e ausente: um erro por código em itemIds', () => {
      expect(reorderIssues(['a', 'b', 'c'], ['a', 'a', 'x']).map((issue) => issue.code)).toEqual([
        'DUPLICATE_IN_LIST',
        'REFERENCE_NOT_FOUND',
        'REQUIRED',
      ]);
      expect(reorderIssues(['a'], ['a', 'a'])[0]).toEqual({
        field: 'itemIds',
        code: 'DUPLICATE_IN_LIST',
        message: 'A ordem enviada não corresponde aos itens do processo. Recarregue a lista.',
      });
    });
  });

  it('mensagem de status não editável (FA-07)', () => {
    expect(itemsNotEditableMessage('AWAITING_APPROVAL')).toBe(
      'Itens não podem ser alterados com o processo aguardando aprovação.',
    );
    expect(itemsNotEditableMessage('SUSPENDED')).toBe(
      'Itens não podem ser alterados com o processo suspenso.',
    );
    expect(itemsNotEditableMessage('DRAFT')).toBe(
      'Itens não podem ser alterados com o processo DRAFT.',
    );
  });
});
