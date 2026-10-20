import { documentSnapshotSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import {
  buildDocumentSnapshot,
  draftSectionsFromSnapshot,
  snapshotHash,
} from './document-snapshot.js';
import type { SnapshotInput } from './document-snapshot.js';
import {
  buildDocument,
  filledSection,
  FIXTURE_NOW,
} from '../../../../test/support/document-fixtures.js';

/*
 * US-065 — snapshot imutável da versão (entities.md §5.3.2 · DEC-084 · RN-DOC-53): conteúdo
 * congelado sem os campos de concorrência e `contentHash` = SHA-256 do JSON canônico (RFC 8785).
 */

const ai = {
  generationId: '0192f065-0000-7000-8000-0000000000e1',
  appliedAt: '2026-10-16T12:00:00.000Z',
  appliedById: '0192f065-0000-7000-8000-0000000000a1',
  reviewedAt: '2026-10-16T12:30:00.000Z',
  reviewedById: '0192f065-0000-7000-8000-0000000000a1',
};

function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    document: buildDocument({
      id: '0192f065-0000-7000-8000-0000000000d1',
      code: 'ETP 0001/2026',
      title: 'ETP da aquisição de cimento',
      draftContent: {
        sections: {
          OBJETO: filledSection('Aquisição de cimento.', { revision: 7, ai }),
          ANEXOS: filledSection('', { state: 'EMPTY', content: null, revision: 2 }),
        },
      },
    }),
    type: { code: 'ETP', kind: 'STRUCTURED' },
    template: {
      templateId: '0192f065-0000-7000-8000-0000000000f1',
      versionId: '0192f065-0000-7000-8000-0000000000f2',
      versionNumber: 3,
    },
    process: {
      id: '0192f065-0000-7000-8000-0000000000b1',
      code: '0012/2026',
      title: 'Aquisição de cimento',
      object: 'Cimento CP-II',
      organizationName: 'Prefeitura de São José',
      organizationCnpj: '11222333000181',
      requestingSecretariatName: 'Secretaria de Obras',
      requestingDepartmentName: 'Setor de Manutenção',
      isBudgetConfidential: false,
    },
    versionNumber: 2,
    header: { object: 'Cimento CP-II' },
    collections: { items: [{ processItemId: 'i1', quantity: '10.0000' }] },
    generatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

describe('buildDocumentSnapshot', () => {
  it('segue o esquema 1 e congela seções sem revision/updatedBy (mantém a proveniência de IA)', () => {
    const snapshot = buildDocumentSnapshot(snapshotInput());
    expect(documentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.document).toEqual({
      id: '0192f065-0000-7000-8000-0000000000d1',
      code: 'ETP 0001/2026',
      title: 'ETP da aquisição de cimento',
      typeCode: 'ETP',
      kind: 'STRUCTURED',
      confidentiality: 'INTERNAL',
      versionNumber: 2,
    });
    expect(Object.keys(snapshot.sections)).toEqual(['ANEXOS', 'OBJETO']);
    expect(snapshot.sections.OBJETO).toEqual({
      state: 'FILLED',
      content: expect.objectContaining({ type: 'doc' }) as unknown,
      justification: null,
      ai,
    });
    expect(snapshot.sections.ANEXOS).not.toHaveProperty('ai');
    expect(snapshot.sections.OBJETO).not.toHaveProperty('revision');
    expect(snapshot.generatedAt).toBe(FIXTURE_NOW.toISOString());
  });

  it('contentHash = SHA-256 do JSON canônico: determinístico e sensível ao conteúdo', () => {
    const snapshot = buildDocumentSnapshot(snapshotInput());
    const hash = snapshotHash(snapshot);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(snapshot)))));
    // Mesmo conteúdo com as seções em outra ordem → mesmo hash.
    const reordered = buildDocumentSnapshot(
      snapshotInput({
        document: {
          ...snapshotInput().document,
          draftContent: {
            sections: {
              ANEXOS: filledSection('', { state: 'EMPTY', content: null, revision: 2 }),
              OBJETO: filledSection('Aquisição de cimento.', { revision: 99, ai }),
            },
          },
        },
      }),
    );
    expect(snapshotHash(reordered)).toBe(hash);
    expect(snapshotHash(buildDocumentSnapshot(snapshotInput({ versionNumber: 3 })))).not.toBe(hash);
  });
});

describe('draftSectionsFromSnapshot (reabertura — RN-DOC-47)', () => {
  it('reconstrói o rascunho da versão com a revisão por seção sempre crescente', () => {
    const snapshot = buildDocumentSnapshot(snapshotInput());
    const now = new Date('2026-10-18T09:00:00.000Z');
    const sections = draftSectionsFromSnapshot(
      snapshot,
      { actorId: '0192f065-0000-7000-8000-0000000000a9', now },
      { OBJETO: filledSection('x', { revision: 7 }) },
    );
    expect(sections.OBJETO).toMatchObject({
      state: 'FILLED',
      revision: 8,
      updatedAt: now.toISOString(),
      updatedById: '0192f065-0000-7000-8000-0000000000a9',
      ai,
    });
    expect(sections.ANEXOS).toMatchObject({ state: 'EMPTY', revision: 1 });
    expect(sections.ANEXOS).not.toHaveProperty('ai');
  });
});
