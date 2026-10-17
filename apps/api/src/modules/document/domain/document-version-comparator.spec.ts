import { richTextFromPlainText } from '@contrataflow/validation';
import type { DocumentSnapshot } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { maskConfidentialSnapshot } from './confidential-snapshot.js';
import { snapshotHash } from './document-snapshot.js';
import { diffDocumentVersions } from './document-version-comparator.js';
import type { ComparedVersion } from './document-version-comparator.js';

/*
 * US-066 — `DocumentVersionComparator` (RN-DOC-60/61 · FA-02/FA-03) e o hash canônico do snapshot
 * (RN-DOC-57 · RFC 8785): campos iguais/diferentes/ausentes, seção NOT_APPLICABLE → FILLED, item
 * removido/adicionado por chave natural e o mascaramento que nunca revela a mudança.
 */

const ID = '0192f066-0000-7000-8000-0000000000d1';
const ITEM_1 = '0192f066-0000-7000-8000-0000000000e1';
const ITEM_2 = '0192f066-0000-7000-8000-0000000000e2';
const ITEM_3 = '0192f066-0000-7000-8000-0000000000e3';

const section = (text: string, overrides: Partial<DocumentSnapshot['sections'][string]> = {}) => ({
  state: 'FILLED' as const,
  content: richTextFromPlainText(text) as DocumentSnapshot['sections'][string]['content'],
  justification: null,
  ...overrides,
});

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    schemaVersion: 1,
    document: {
      id: ID,
      code: 'ETP 0003/2026',
      title: 'ETP da aquisição de cimento',
      typeCode: 'ETP',
      kind: 'STRUCTURED',
      confidentiality: 'PUBLIC',
      versionNumber: 1,
    },
    template: { templateId: ID, versionId: ID, versionNumber: 1 },
    process: {
      id: ID,
      code: 'PRC 0001/2026',
      title: 'Compra de cimento',
      object: 'Cimento',
      organizationName: 'Prefeitura A',
      organizationCnpj: null,
      requestingSecretariatName: null,
      requestingDepartmentName: null,
      isBudgetConfidential: true,
    },
    header: { objective: 'Pavimentar', estimatedValue: '1000.00' },
    sections: {
      JUSTIFICATIVA: section('Necessidade de pavimentação.'),
      RISCOS: section('', { state: 'NOT_APPLICABLE', content: null, justification: 'Sem riscos.' }),
    },
    collections: {
      items: [
        { processItemId: ITEM_1, sequence: 1, description: 'Cimento', quantity: '10' },
        { processItemId: ITEM_2, sequence: 2, description: 'Areia', quantity: '5' },
      ],
    },
    generatedAt: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

const side = (content: DocumentSnapshot | null, hash = 'a'.repeat(64)): ComparedVersion => ({
  content,
  contentHash: hash,
  attachmentId: null,
});

describe('hash canônico do snapshot (RN-DOC-57 · RFC 8785)', () => {
  it('chaves fora de ordem produzem o mesmo contentHash; qualquer valor diferente muda o hash', () => {
    const base = snapshot();
    const reordered = JSON.parse(
      JSON.stringify({
        generatedAt: base.generatedAt,
        collections: base.collections,
        sections: base.sections,
        header: { estimatedValue: '1000.00', objective: 'Pavimentar' },
        process: base.process,
        template: base.template,
        document: base.document,
        schemaVersion: 1,
      }),
    ) as DocumentSnapshot;
    expect(snapshotHash(reordered)).toBe(snapshotHash(base));
    expect(snapshotHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      snapshotHash(snapshot({ header: { objective: 'Pavimentar', estimatedValue: '1000.01' } })),
    ).not.toBe(snapshotHash(base));
  });
});

describe('DocumentVersionComparator.diff (RN-DOC-60)', () => {
  it('versões idênticas: tudo UNCHANGED (inclusive com chaves em outra ordem)', () => {
    const base = snapshot();
    const reordered = snapshot({ header: { estimatedValue: '1000.00', objective: 'Pavimentar' } });
    const diff = diffDocumentVersions('STRUCTURED', side(base), side(reordered));
    expect(diff.header.every((entry) => entry.changeType === 'UNCHANGED')).toBe(true);
    expect(diff.sections.map((entry) => entry.changeType)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect(diff.collections.map((entry) => entry.changeType)).toEqual(['UNCHANGED', 'UNCHANGED']);
  });

  it('cabeçalho: campo alterado, adicionado e removido; metadados do documento e do template', () => {
    const from = snapshot({ header: { objective: 'Pavimentar', deadline: '30 dias' } });
    const to = snapshot({
      document: { ...snapshot().document, title: 'ETP revisto' },
      template: { templateId: ID, versionId: ID, versionNumber: 2 },
      header: { objective: 'Pavimentar ruas', scope: 'Centro' },
    });
    const { header } = diffDocumentVersions('STRUCTURED', side(from), side(to));
    expect(header).toEqual([
      {
        field: 'document.title',
        changeType: 'CHANGED',
        from: 'ETP da aquisição de cimento',
        to: 'ETP revisto',
      },
      {
        field: 'document.code',
        changeType: 'UNCHANGED',
        from: 'ETP 0003/2026',
        to: 'ETP 0003/2026',
      },
      { field: 'document.confidentiality', changeType: 'UNCHANGED', from: 'PUBLIC', to: 'PUBLIC' },
      { field: 'template.versionNumber', changeType: 'CHANGED', from: 1, to: 2 },
      { field: 'deadline', changeType: 'REMOVED', from: '30 dias', to: null },
      { field: 'objective', changeType: 'CHANGED', from: 'Pavimentar', to: 'Pavimentar ruas' },
      { field: 'scope', changeType: 'ADDED', from: null, to: 'Centro' },
    ]);
  });

  it('seções: NOT_APPLICABLE → FILLED muda; seção nova é ADDED e a retirada REMOVED; texto extraído do TipTap', () => {
    const from = snapshot({
      sections: {
        JUSTIFICATIVA: section('Necessidade de pavimentação.'),
        RISCOS: section('', {
          state: 'NOT_APPLICABLE',
          content: null,
          justification: 'Sem riscos.',
        }),
        ANEXOS: section('Planta baixa.'),
      },
    });
    const to = snapshot({
      sections: {
        JUSTIFICATIVA: section('Necessidade de pavimentação.'),
        RISCOS: section('Risco de atraso na entrega.'),
        OBJETO: section('Aquisição de cimento.\nEntrega parcelada.'),
      },
    });
    const { sections } = diffDocumentVersions('STRUCTURED', side(from), side(to));
    expect(sections).toEqual([
      {
        sectionKey: 'ANEXOS',
        changeType: 'REMOVED',
        from: { state: 'FILLED', text: 'Planta baixa.', justification: null },
        to: null,
      },
      {
        sectionKey: 'JUSTIFICATIVA',
        changeType: 'UNCHANGED',
        from: expect.any(Object) as unknown,
        to: expect.any(Object) as unknown,
      },
      {
        sectionKey: 'OBJETO',
        changeType: 'ADDED',
        from: null,
        to: {
          state: 'FILLED',
          text: 'Aquisição de cimento.\nEntrega parcelada.',
          justification: null,
        },
      },
      {
        sectionKey: 'RISCOS',
        changeType: 'CHANGED',
        from: { state: 'NOT_APPLICABLE', text: '', justification: 'Sem riscos.' },
        to: { state: 'FILLED', text: 'Risco de atraso na entrega.', justification: null },
      },
    ]);
  });

  it('seção com o mesmo texto mas formatação diferente conta como alteração', () => {
    const bold = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Texto', marks: [{ type: 'bold' }] }],
        },
      ],
    } as DocumentSnapshot['sections'][string]['content'];
    const from = snapshot({ sections: { A: section('Texto') } });
    const to = snapshot({ sections: { A: section('Texto', { content: bold }) } });
    const [entry] = diffDocumentVersions('STRUCTURED', side(from), side(to)).sections;
    expect(entry).toMatchObject({
      changeType: 'CHANGED',
      from: { text: 'Texto' },
      to: { text: 'Texto' },
    });
  });

  it('coleções: item por processItemId — alterado (campos), removido e adicionado; os removidos ao final', () => {
    const to = snapshot({
      collections: {
        items: [
          { processItemId: ITEM_3, sequence: 1, description: 'Brita', quantity: '2' },
          { processItemId: ITEM_1, sequence: 2, description: 'Cimento CP-II', quantity: '10' },
        ],
        risks: [{ id: 'r1', title: 'Atraso' }],
      },
    });
    const { collections } = diffDocumentVersions('STRUCTURED', side(snapshot()), side(to));
    expect(
      collections.map((entry) => [
        entry.collection,
        entry.itemId,
        entry.changeType,
        entry.changedFields,
      ]),
    ).toEqual([
      ['items', ITEM_3, 'ADDED', []],
      ['items', ITEM_1, 'CHANGED', ['sequence', 'description']],
      ['items', ITEM_2, 'REMOVED', []],
      ['risks', 'r1', 'ADDED', []],
    ]);
    expect(collections[2]).toMatchObject({ from: { description: 'Areia' }, to: null });
  });

  it('linhas sem chave natural (ou repetida) usam a posição; valores primitivos viram { value }', () => {
    const from = snapshot({
      collections: {
        notes: ['a', 'b'],
        dupes: [
          { id: 'x', n: 1 },
          { id: 'x', n: 2 },
        ],
      },
    });
    const to = snapshot({
      collections: {
        notes: ['a', 'c'],
        dupes: [
          { id: 'x', n: 1 },
          { id: 'x', n: 3 },
        ],
      },
    });
    const { collections } = diffDocumentVersions('STRUCTURED', side(from), side(to));
    expect(
      collections.map((entry) => `${entry.collection}:${entry.itemId}:${entry.changeType}`),
    ).toEqual(['dupes:x:UNCHANGED', 'dupes:#2:CHANGED', 'notes:#1:UNCHANGED', 'notes:#2:CHANGED']);
  });

  it('documento externo (FA-02): só metadados do arquivo, sem diff de conteúdo', () => {
    const diff = diffDocumentVersions(
      'UPLOADED',
      { content: null, contentHash: 'a'.repeat(64), attachmentId: ITEM_1 },
      { content: null, contentHash: 'b'.repeat(64), attachmentId: ITEM_2 },
    );
    expect(diff).toEqual({
      header: [
        { field: 'file.attachmentId', changeType: 'CHANGED', from: ITEM_1, to: ITEM_2 },
        { field: 'file.sha256', changeType: 'CHANGED', from: 'a'.repeat(64), to: 'b'.repeat(64) },
      ],
      sections: [],
      collections: [],
    });
  });

  it('snapshot ausente num lado de documento estruturado: tudo do outro lado é ADDED', () => {
    const diff = diffDocumentVersions('FREE_TEXT', side(null), side(snapshot()));
    expect(new Set(diff.header.map((entry) => entry.changeType))).toEqual(new Set(['ADDED']));
    expect(new Set(diff.sections.map((entry) => entry.changeType))).toEqual(new Set(['ADDED']));
  });
});

describe('POL-09 na comparação (RN-DOC-61 · FA-03)', () => {
  const priced = (unitPrice: string, estimatedValue: string) =>
    snapshot({
      header: { objective: 'Pavimentar', estimatedValue },
      collections: {
        priceItems: [
          {
            id: 'p1',
            description: 'Cimento',
            unitPrice,
            quotations: [{ id: 'q1', supplier: 'ACME', unitPrice }],
          },
        ],
      },
    });

  it('mascara campos monetários do cabeçalho e das coleções (inclusive aninhados) com <campo>Masked', () => {
    const masked = maskConfidentialSnapshot(priced('10.00', '1000.00'));
    expect(masked.header).toEqual({
      objective: 'Pavimentar',
      estimatedValue: null,
      estimatedValueMasked: true,
    });
    expect(masked.collections.priceItems).toEqual([
      {
        id: 'p1',
        description: 'Cimento',
        unitPrice: null,
        unitPriceMasked: true,
        quotations: [{ id: 'q1', supplier: 'ACME', unitPrice: null, unitPriceMasked: true }],
      },
    ]);
    // Seções e metadados não mudam; o original fica intacto.
    expect(masked.sections).toEqual(priced('10.00', '1000.00').sections);
    expect(priced('10.00', '1000.00').header.estimatedValue).toBe('1000.00');
  });

  it('campo sigiloso vira MASKED com os dois lados nulos — alterado ou não, nada se infere', () => {
    const changed = diffDocumentVersions(
      'STRUCTURED',
      side(maskConfidentialSnapshot(priced('10.00', '1000.00'))),
      side(maskConfidentialSnapshot(priced('12.00', '1200.00'))),
    );
    const unchanged = diffDocumentVersions(
      'STRUCTURED',
      side(maskConfidentialSnapshot(priced('10.00', '1000.00'))),
      side(maskConfidentialSnapshot(priced('10.00', '1000.00'))),
    );
    for (const diff of [changed, unchanged]) {
      expect(diff.header.find((entry) => entry.field === 'estimatedValue')).toEqual({
        field: 'estimatedValue',
        changeType: 'MASKED',
        from: null,
        to: null,
      });
      expect(diff.header.some((entry) => entry.field.endsWith('Masked'))).toBe(false);
      const [row] = diff.collections;
      expect(row).toMatchObject({
        changeType: 'UNCHANGED',
        changedFields: [],
        maskedFields: ['unitPrice'],
      });
    }
    expect(changed.collections[0]?.from).toEqual(unchanged.collections[0]?.from);
  });

  it('sem mascaramento o mesmo par mostra a mudança dos valores', () => {
    const diff = diffDocumentVersions(
      'STRUCTURED',
      side(priced('10.00', '1000.00')),
      side(priced('12.00', '1200.00')),
    );
    expect(diff.header.find((entry) => entry.field === 'estimatedValue')).toMatchObject({
      changeType: 'CHANGED',
      from: '1000.00',
      to: '1200.00',
    });
    expect(diff.collections[0]).toMatchObject({
      changeType: 'CHANGED',
      changedFields: ['unitPrice', 'quotations'],
      maskedFields: [],
    });
  });
});
