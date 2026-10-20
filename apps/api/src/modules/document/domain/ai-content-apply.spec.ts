import { describe, expect, it } from 'vitest';

import {
  AiApplyRejectedError,
  applyAiSections,
  isAiReplacement,
  isDefaultAiSelection,
} from './ai-content-apply.js';
import type { AiApplyInput } from './ai-content-apply.js';
import { DocumentTransitionError } from './document.js';
import { buildDocument, filledSection } from '../../../../test/support/document-fixtures.js';

/*
 * US-117 — `Document.applyAiSections` (DOC-26 · RN-AI-27..29): aplicação seletiva, confirmação da
 * substituição, `NOT_APPLICABLE` → `FILLED`, revisões, proveniência pendente e falha fechada.
 */

const RITA = '0192d117-0000-7000-8000-0000000000c1';
const G1 = '0192d117-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-10-18T10:00:00.000Z');

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const PROPOSAL = [
  { sectionKey: 'JUSTIFICATION', content: doc('Justificativa proposta.') },
  { sectionKey: 'EXPECTED_RESULTS', content: doc('Resultados propostos.') },
  { sectionKey: 'NOTES', content: doc('Observações propostas.') },
];

function documentWith(sections: Record<string, ReturnType<typeof filledSection>> = {}) {
  return buildDocument({ draftRevision: 6, draftContent: { sections } });
}

function input(overrides: Partial<AiApplyInput> = {}): AiApplyInput {
  return {
    generationId: G1,
    proposal: PROPOSAL,
    sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
    confirmReplaceFilled: false,
    maxCharsOf: () => 50_000,
    actorId: RITA,
    now: NOW,
    ...overrides,
  };
}

describe('applyAiSections (DOC-26 · RN-AI-28/29)', () => {
  it('aplica as seções vazias: FILLED, revision + 1, ai pendente e draftRevision + 1', () => {
    const outcome = applyAiSections(documentWith(), input());
    expect(outcome.appliedSectionKeys).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS']);
    expect(outcome.replacedSectionKeys).toEqual([]);
    const section = outcome.document.draftContent.sections.JUSTIFICATION;
    expect(section).toMatchObject({
      state: 'FILLED',
      content: doc('Justificativa proposta.'),
      justification: null,
      revision: 1,
      updatedById: RITA,
      ai: { generationId: G1, appliedById: RITA, reviewedAt: null, reviewedById: null },
    });
    expect(outcome.document.draftRevision).toBe(7);
    expect(outcome.document.draftContent.sections.NOTES).toBeUndefined();
  });

  it('seção preenchida sem confirmReplaceFilled → CONFIRM_REPLACE_REQUIRED (V-10), nada muda', () => {
    const document = documentWith({
      JUSTIFICATION: filledSection('Texto de Rita', { revision: 3 }),
    });
    expect(() => applyAiSections(document, input())).toThrow(
      expect.objectContaining({
        reason: 'CONFIRM_REPLACE_REQUIRED',
        sectionKeys: ['JUSTIFICATION'],
      }),
    );
  });

  it('com confirmação substitui a preenchida (revisão seguinte) e informa a substituição', () => {
    const document = documentWith({
      JUSTIFICATION: filledSection('Texto de Rita', { revision: 3 }),
    });
    const outcome = applyAiSections(document, input({ confirmReplaceFilled: true }));
    expect(outcome.replacedSectionKeys).toEqual(['JUSTIFICATION']);
    expect(outcome.document.draftContent.sections.JUSTIFICATION?.revision).toBe(4);
  });

  it('NOT_APPLICABLE substituída vira FILLED e perde a justificativa', () => {
    const document = documentWith({
      NOTES: {
        ...filledSection('x', { revision: 2 }),
        state: 'NOT_APPLICABLE',
        content: null,
        justification: 'Não há dependências com outras demandas.',
      },
    });
    const outcome = applyAiSections(
      document,
      input({ sectionKeys: ['NOTES'], confirmReplaceFilled: true }),
    );
    expect(outcome.document.draftContent.sections.NOTES).toMatchObject({
      state: 'FILLED',
      justification: null,
      revision: 3,
    });
  });

  it('chave fora da proposta → SECTION_NOT_IN_PROPOSAL', () => {
    expect(() => applyAiSections(documentWith(), input({ sectionKeys: ['OBJECT'] }))).toThrow(
      AiApplyRejectedError,
    );
  });

  it('conteúdo acima do limite da seção ou fora do schema → CONTENT_INVALID (falha fechada)', () => {
    expect(() => applyAiSections(documentWith(), input({ maxCharsOf: () => 5 }))).toThrow(
      expect.objectContaining({ reason: 'CONTENT_INVALID' }),
    );
    const bad = [
      {
        sectionKey: 'JUSTIFICATION',
        content: { type: 'doc' as const, content: [{ type: 'script' }] },
      },
    ];
    expect(() =>
      applyAiSections(documentWith(), input({ proposal: bad, sectionKeys: ['JUSTIFICATION'] })),
    ).toThrow(expect.objectContaining({ reason: 'CONTENT_INVALID' }));
  });

  it('documento fora de DRAFT/RETURNED → NOT_EDITABLE', () => {
    const document = buildDocument({ status: 'IN_REVIEW' });
    expect(() => applyAiSections(document, input())).toThrow(DocumentTransitionError);
  });

  it('repetir a chave aplica uma vez', () => {
    const outcome = applyAiSections(documentWith(), input({ sectionKeys: ['NOTES', 'NOTES'] }));
    expect(outcome.appliedSectionKeys).toEqual(['NOTES']);
  });
});

describe('marcação padrão do painel (fluxo principal 7)', () => {
  it('EMPTY ou ausente marcada; FILLED/NOT_APPLICABLE desmarcadas (substituiria o texto)', () => {
    const filled = filledSection('Texto', { revision: 1 });
    expect(isDefaultAiSelection(undefined)).toBe(true);
    expect(isDefaultAiSelection({ ...filled, state: 'EMPTY', content: null })).toBe(true);
    expect(isDefaultAiSelection(filled)).toBe(false);
    expect(isAiReplacement({ ...filled, state: 'NOT_APPLICABLE' })).toBe(true);
  });
});
