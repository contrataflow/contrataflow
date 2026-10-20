import { describe, expect, it } from 'vitest';

import type { DocumentItem } from './document-items.js';
import { DocumentTransitionError } from './document.js';
import {
  applyImportedSections,
  ImportedSectionRejectedError,
  planImportedItems,
} from './imported-content.js';
import { buildDocument, filledSection } from '../../../../test/support/document-fixtures.js';

/*
 * US-037 — conteúdo importado no documento (TRM-06 · DEC-017/019): seções `FILLED` com a revisão
 * seguinte e a proveniência decidida pelo dono, limite da seção, documento não editável e o upsert
 * dos itens por `processItemId`.
 */

const CARLA = '0192d037-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-20T10:00:00.000Z');
const P1 = '0192d037-0000-7000-8000-0000000000f1';
const P2 = '0192d037-0000-7000-8000-0000000000f2';
const P3 = '0192d037-0000-7000-8000-0000000000f3';

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('applyImportedSections', () => {
  const document = buildDocument({
    draftRevision: 4,
    draftContent: {
      sections: {
        OBJECT: filledSection('Objeto antigo', { revision: 3 }),
        JUSTIFICATION: {
          state: 'NOT_APPLICABLE',
          content: null,
          justification: 'Não se aplica a este caso concreto.',
          revision: 2,
          updatedAt: NOW.toISOString(),
          updatedById: CARLA,
        },
      },
    },
  });

  it('grava as seções como FILLED, revisão + 1, sem justificativa, e o rascunho + 1', () => {
    const ai = {
      generationId: '0192d037-0000-7000-8000-0000000000a1',
      appliedAt: NOW.toISOString(),
      appliedById: CARLA,
      reviewedAt: null,
      reviewedById: null,
    };
    const next = applyImportedSections(document, {
      sections: [
        { key: 'OBJECT', content: doc('Objeto do ETP'), ai: null },
        { key: 'JUSTIFICATION', content: doc('Justificativa do ETP'), ai },
        { key: 'SPECIFICATIONS', content: doc('Requisitos'), ai: null },
      ],
      maxCharsOf: () => 1000,
      actorId: CARLA,
      now: NOW,
    });
    expect(next.draftRevision).toBe(5);
    expect(next.updatedById).toBe(CARLA);
    expect(next.draftContent.sections.OBJECT).toMatchObject({
      state: 'FILLED',
      content: doc('Objeto do ETP'),
      revision: 4,
      justification: null,
    });
    expect(next.draftContent.sections.OBJECT?.ai).toBeUndefined();
    expect(next.draftContent.sections.JUSTIFICATION).toMatchObject({
      state: 'FILLED',
      justification: null,
      revision: 3,
      ai,
    });
    expect(next.draftContent.sections.SPECIFICATIONS?.revision).toBe(1);
  });

  it('sem seções devolve o mesmo documento', () => {
    expect(
      applyImportedSections(document, {
        sections: [],
        maxCharsOf: () => 10,
        actorId: CARLA,
        now: NOW,
      }),
    ).toBe(document);
  });

  it('conteúdo acima do limite da seção é recusado (falha fechada)', () => {
    expect(() =>
      applyImportedSections(document, {
        sections: [{ key: 'OBJECT', content: doc('x'.repeat(50)), ai: null }],
        maxCharsOf: (key) => (key === 'OBJECT' ? 10 : undefined),
        actorId: CARLA,
        now: NOW,
      }),
    ).toThrow(ImportedSectionRejectedError);
  });

  it('documento fora de DRAFT/RETURNED não é editável', () => {
    expect(() =>
      applyImportedSections(
        { ...document, status: 'FINALIZED' },
        { sections: [], maxCharsOf: () => 10, actorId: CARLA, now: NOW },
      ),
    ).toThrow(DocumentTransitionError);
  });
});

describe('planImportedItems (RN-TR-21 · DEC-019)', () => {
  const row = (processItemId: string, quantity: string, sortOrder: number): DocumentItem => ({
    id: `row-${processItemId}`,
    tenantId: 't',
    documentId: 'd',
    processItemId,
    quantity,
    notes: 'Obs. do TR',
    sortOrder,
    calculationMemo: null,
    specification: null,
    acceptanceCriteria: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: CARLA,
    updatedById: CARLA,
  });
  let counter = 0;
  const newId = () => `new-${String((counter += 1))}`;

  it('atualiza a quantidade, inclui os novos no fim e preserva as linhas fora da importação', () => {
    const current = [row(P1, '1.0000', 0), row(P2, '5.0000', 3)];
    const plan = planImportedItems({
      tenantId: 't',
      documentId: 'd',
      current,
      lines: [
        { processItemId: P1, quantity: '10.0000', replaceQuantity: true },
        { processItemId: P3, quantity: '2.0000', replaceQuantity: true, notes: 'Memória' },
        { processItemId: P3, quantity: '9.0000', replaceQuantity: true },
      ],
      actorId: CARLA,
      now: NOW,
      newId,
    });
    expect(plan.written).toEqual([P1, P3]);
    expect(plan.items).toHaveLength(3);
    expect(plan.items[0]).toMatchObject({
      processItemId: P1,
      quantity: '10.0000',
      notes: 'Obs. do TR',
    });
    expect(plan.items[1]).toBe(current[1]);
    expect(plan.items[2]).toMatchObject({
      processItemId: P3,
      quantity: '2.0000',
      notes: 'Memória',
      sortOrder: 4,
      createdById: CARLA,
    });
  });

  it('copyQuantities = false mantém a quantidade da linha existente; linha igual não muda', () => {
    const current = [row(P1, '1.0000', 0)];
    const plan = planImportedItems({
      tenantId: 't',
      documentId: 'd',
      current,
      lines: [{ processItemId: P1, quantity: '10.0000', replaceQuantity: false }],
      actorId: CARLA,
      now: NOW,
      newId,
    });
    expect(plan.written).toEqual([P1]);
    expect(plan.items[0]).toBe(current[0]);
  });
});
