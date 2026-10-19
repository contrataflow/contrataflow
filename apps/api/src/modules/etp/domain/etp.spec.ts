import { richTextPlainText } from '@contrataflow/validation';
import type { DocumentSnapshot } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  createEtp,
  dfdImportPreview,
  pcaAlignmentText,
  planDfdImport,
  setEtpEstimate,
} from './etp.js';

const ITEM_1 = '0192d019-0000-7000-8000-000000000001';
const ITEM_2 = '0192d019-0000-7000-8000-000000000002';
const NOW = new Date('2026-10-18T12:00:00.000Z');

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    schemaVersion: 1,
    document: {
      id: '0192d019-0000-7000-8000-0000000000d1',
      code: 'DFD 0005/2026',
      title: 'DFD — Manutenção',
      typeCode: 'DFD',
      kind: 'STRUCTURED',
      confidentiality: 'INTERNAL',
      versionNumber: 1,
    },
    template: null,
    process: {
      id: '0192d019-0000-7000-8000-0000000000p1',
      code: '0012/2026',
      title: 'Manutenção predial',
      object: 'Manutenção predial',
      organizationName: 'Prefeitura',
      organizationCnpj: null,
      requestingSecretariatName: null,
      requestingDepartmentName: null,
      isBudgetConfidential: false,
    },
    header: {
      objectSummary: 'Contratação de manutenção predial preventiva',
      pcaStatus: 'PLANNED',
      pcaYear: 2026,
      pcaItemCode: 'PCA-42',
      pcaJustification: null,
    },
    sections: {
      JUSTIFICATION: {
        state: 'FILLED',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Prédios degradados.' }] },
          ],
        },
        justification: null,
      },
    },
    collections: {
      items: [
        { processItemId: ITEM_2, quantity: '12.0000', notes: null, sortOrder: 1 },
        { processItemId: ITEM_1, quantity: '100.0000', notes: 'x', sortOrder: 0 },
      ],
    },
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('createEtp (RN-ETP-01/05)', () => {
  it('nasce com conclusão PENDING, id do documento, versão 1 e a origem da importação', () => {
    const etp = createEtp({
      documentId: 'doc',
      tenantId: 't',
      processId: 'p',
      importedFromDfdVersionId: 'v1',
      creatorId: 'u',
      now: NOW,
    });
    expect(etp).toMatchObject({
      id: 'doc',
      documentId: 'doc',
      conclusion: 'PENDING',
      importedFromDfdVersionId: 'v1',
      parcelingDecision: null,
      estimatedTotalValue: null,
      createdById: 'u',
      version: 1,
    });
  });
});

describe('planDfdImport (RN-ETP-05/06)', () => {
  it('copia objeto + justificativa, a situação no PCA e os itens na ordem do DFD', () => {
    const plan = planDfdImport(snapshot());
    expect(richTextPlainText(plan.sections.NEED_DESCRIPTION)).toBe(
      'Contratação de manutenção predial preventiva\nPrédios degradados.',
    );
    expect(richTextPlainText(plan.sections.PCA_ALIGNMENT)).toBe(
      'A contratação está prevista no Plano de Contratações Anual de 2026, item PCA-42.',
    );
    expect(plan.items).toEqual([
      { processItemId: ITEM_1, quantity: '100.0000' },
      { processItemId: ITEM_2, quantity: '12.0000' },
    ]);
  });

  it('sem justificativa usa só o objeto; item repetido conta uma vez; quantidade numérica vira Decimal(18,4)', () => {
    const plan = planDfdImport(
      snapshot({
        sections: {},
        collections: {
          items: [
            { processItemId: ITEM_1, quantity: 3 },
            { processItemId: ITEM_1, quantity: '4.0000' },
          ],
        },
      }),
    );
    expect(richTextPlainText(plan.sections.NEED_DESCRIPTION)).toBe(
      'Contratação de manutenção predial preventiva',
    );
    expect(plan.items).toEqual([{ processItemId: ITEM_1, quantity: '3.0000' }]);
  });

  it('snapshot sem cabeçalho nem itens não preenche seção nem cria item', () => {
    const plan = planDfdImport(snapshot({ header: {}, sections: {}, collections: {} }));
    expect(plan).toEqual({ sections: {}, items: [] });
    // Cabeçalho e itens fora do formato: só a justificativa vai para NEED_DESCRIPTION.
    const malformed = planDfdImport(
      snapshot({ header: { pcaStatus: 'X' }, collections: { items: 'x' } as never }),
    );
    expect(Object.keys(malformed.sections)).toEqual(['NEED_DESCRIPTION']);
    expect(richTextPlainText(malformed.sections.NEED_DESCRIPTION)).toBe('Prédios degradados.');
    expect(malformed.items).toEqual([]);
  });
});

describe('pcaAlignmentText', () => {
  it('descreve cada situação no PCA', () => {
    expect(pcaAlignmentText({ pcaStatus: 'PLANNED' })).toBe(
      'A contratação está prevista no Plano de Contratações Anual.',
    );
    expect(pcaAlignmentText({ pcaStatus: 'NOT_PLANNED' })).toBe(
      'A contratação não está prevista no Plano de Contratações Anual.',
    );
    expect(
      pcaAlignmentText({ pcaStatus: 'NOT_PLANNED', pcaJustification: ' Demanda nova. ' }),
    ).toBe(
      'A contratação não está prevista no Plano de Contratações Anual. Justificativa: Demanda nova.',
    );
    expect(pcaAlignmentText({ pcaStatus: 'NOT_APPLICABLE' })).toBe(
      'A contratação não se sujeita ao Plano de Contratações Anual (não se aplica).',
    );
  });
});

describe('dfdImportPreview', () => {
  it('resume objeto, situação no PCA e itens distintos', () => {
    expect(dfdImportPreview(snapshot())).toEqual({
      objectSummary: 'Contratação de manutenção predial preventiva',
      pcaStatus: 'PLANNED',
      itemsCount: 2,
    });
    expect(dfdImportPreview(snapshot({ header: { pcaStatus: 1 }, collections: {} }))).toEqual({
      objectSummary: '',
      pcaStatus: null,
      itemsCount: 0,
    });
  });
});

describe('setEtpEstimate (US-022 · RN-ETP-28 · FA-01/02/03)', () => {
  const RESEARCH = '0192d022-0000-7000-8000-0000000000e1';
  const LATER = new Date('2026-10-19T12:00:00.000Z');
  const base = createEtp({
    documentId: '0192d022-0000-7000-8000-0000000000d1',
    tenantId: 't',
    processId: 'p',
    importedFromDfdVersionId: null,
    creatorId: 'u0',
    now: NOW,
  });

  it('MANUAL: grava valor e origem, sem pesquisa, com versão + 1 e os campos alterados', () => {
    const { etp, changes } = setEtpEstimate(
      base,
      { source: 'MANUAL', value: '98000.50' },
      { actorId: 'u1', now: LATER },
    );
    expect(etp).toMatchObject({
      estimatedValueSource: 'MANUAL',
      estimatedTotalValue: '98000.50',
      priceResearchId: null,
      updatedById: 'u1',
      updatedAt: LATER,
      version: 2,
    });
    expect(changes).toEqual([
      { field: 'estimatedValueSource', old: null, new: 'MANUAL' },
      { field: 'estimatedTotalValue', old: null, new: '98000.50' },
    ]);
  });

  it('FA-01: manual → pesquisa descarta o manual pelo total da pesquisa', () => {
    const manual = setEtpEstimate(
      base,
      { source: 'MANUAL', value: '1.00' },
      { actorId: 'u1', now: LATER },
    ).etp;
    const { etp, changes } = setEtpEstimate(
      manual,
      { source: 'PRICE_RESEARCH', priceResearchId: RESEARCH, value: '125000.00' },
      { actorId: 'u1', now: LATER },
    );
    expect(etp).toMatchObject({
      estimatedValueSource: 'PRICE_RESEARCH',
      estimatedTotalValue: '125000.00',
      priceResearchId: RESEARCH,
      version: 3,
    });
    expect(changes.map((change) => change.field)).toEqual([
      'estimatedValueSource',
      'estimatedTotalValue',
      'priceResearchId',
    ]);
  });

  it('FA-03: pesquisa sem cálculo deixa o valor ausente; reenvio igual não muda nada', () => {
    const linked = setEtpEstimate(
      base,
      { source: 'PRICE_RESEARCH', priceResearchId: RESEARCH, value: null },
      { actorId: 'u1', now: LATER },
    ).etp;
    expect(linked.estimatedTotalValue).toBeNull();
    const again = setEtpEstimate(
      linked,
      { source: 'PRICE_RESEARCH', priceResearchId: RESEARCH, value: null },
      { actorId: 'u2', now: LATER },
    );
    expect(again.changes).toEqual([]);
    expect(again.etp).toBe(linked);
  });
});
