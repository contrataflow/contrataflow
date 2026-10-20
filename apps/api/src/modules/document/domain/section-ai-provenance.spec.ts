import { describe, expect, it } from 'vitest';

import { DocumentTransitionError } from './document.js';
import {
  AiReviewConflictError,
  aiAfterSave,
  isAiReviewPending,
  reviewAiSections,
  withAiApplied,
} from './section-ai-provenance.js';
import { buildDocument, filledSection } from '../../../../test/support/document-fixtures.js';

/*
 * US-122 — proveniência de IA por seção (RN-AI-55/56 · entities.md §5.10): revisão (DOC-27),
 * reaplicação (FA-02), edição (FA-01) e limpeza (FA-04).
 */

const CARLA = '0192f065-0000-7000-8000-0000000000c1';
const G1 = '0192f065-0000-7000-8000-0000000000e1';
const G2 = '0192f065-0000-7000-8000-0000000000e2';
const NOW = new Date('2026-10-17T10:00:00.000Z');

const pending = (generationId = G1) => ({
  generationId,
  appliedAt: '2026-10-16T12:00:00.000Z',
  appliedById: CARLA,
  reviewedAt: null,
  reviewedById: null,
});

function documentWith(sections: Parameters<typeof buildDocument>[0] = {}) {
  return buildDocument({
    draftRevision: 7,
    draftContent: {
      sections: {
        JUSTIFICATION: filledSection('Texto gerado', { revision: 4, ai: pending() }),
        EXPECTED_RESULTS: filledSection('Outro texto', { revision: 2, ai: pending(G2) }),
        MANUAL: filledSection('Escrito à mão', { revision: 9 }),
      },
    },
    ...sections,
  });
}

describe('reviewAiSections (DOC-27 · RN-AI-56)', () => {
  it('revisa a seção pendente: reviewedAt/By, revision + 1 e draftRevision + 1', () => {
    const outcome = reviewAiSections(documentWith(), {
      sectionKeys: ['JUSTIFICATION'],
      expectedRevisions: { JUSTIFICATION: 4 },
      actorId: CARLA,
      now: NOW,
    });
    expect(outcome.reviewedSectionKeys).toEqual(['JUSTIFICATION']);
    expect(outcome.generationIds).toEqual([G1]);
    const section = outcome.document.draftContent.sections.JUSTIFICATION;
    expect(section?.revision).toBe(5);
    expect(section?.ai).toMatchObject({
      generationId: G1,
      reviewedAt: NOW.toISOString(),
      reviewedById: CARLA,
    });
    expect(outcome.document.draftRevision).toBe(8);
    expect(outcome.document.updatedById).toBe(CARLA);
    // O conteúdo e as outras seções não mudam.
    expect(section?.content).toEqual(documentWith().draftContent.sections.JUSTIFICATION?.content);
    expect(isAiReviewPending(outcome.document.draftContent.sections.EXPECTED_RESULTS)).toBe(true);
  });

  it('lote: uma geração por seção, sem repetir; seção manual e chave repetida ignoradas (FA-07)', () => {
    const outcome = reviewAiSections(documentWith(), {
      sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS', 'MANUAL', 'JUSTIFICATION'],
      expectedRevisions: { JUSTIFICATION: 4, EXPECTED_RESULTS: 2, MANUAL: 1 },
      actorId: CARLA,
      now: NOW,
    });
    expect(outcome.reviewedSectionKeys).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS']);
    expect(outcome.generationIds).toEqual([G1, G2]);
    expect(outcome.document.draftContent.sections.MANUAL?.revision).toBe(9);
  });

  it('repetida: nada pendente → nada muda, sem conferir a revisão (idempotente)', () => {
    const first = reviewAiSections(documentWith(), {
      sectionKeys: ['JUSTIFICATION'],
      expectedRevisions: { JUSTIFICATION: 4 },
      actorId: CARLA,
      now: NOW,
    });
    const again = reviewAiSections(first.document, {
      sectionKeys: ['JUSTIFICATION'],
      expectedRevisions: { JUSTIFICATION: 4 },
      actorId: CARLA,
      now: NOW,
    });
    expect(again.reviewedSectionKeys).toEqual([]);
    expect(again.generationIds).toEqual([]);
    expect(again.document).toBe(first.document);
  });

  it('revisão divergente (V-04): AiReviewConflictError com as revisões atuais e nada revisado', () => {
    const document = documentWith();
    const attempt = () =>
      reviewAiSections(document, {
        sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
        expectedRevisions: { JUSTIFICATION: 3, EXPECTED_RESULTS: 2 },
        actorId: CARLA,
        now: NOW,
      });
    expect(attempt).toThrow(AiReviewConflictError);
    try {
      attempt();
    } catch (error) {
      expect((error as AiReviewConflictError).current).toEqual({ JUSTIFICATION: 4 });
    }
    expect(isAiReviewPending(document.draftContent.sections.JUSTIFICATION)).toBe(true);
  });

  it('documento fora de DRAFT/RETURNED (V-06): NOT_EDITABLE', () => {
    for (const status of ['FINALIZED', 'IN_REVIEW', 'CANCELED'] as const) {
      expect(() =>
        reviewAiSections(documentWith({ status }), {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
          actorId: CARLA,
          now: NOW,
        }),
      ).toThrow(DocumentTransitionError);
    }
    expect(
      reviewAiSections(documentWith({ status: 'RETURNED' }), {
        sectionKeys: ['JUSTIFICATION'],
        expectedRevisions: { JUSTIFICATION: 4 },
        actorId: CARLA,
        now: NOW,
      }).reviewedSectionKeys,
    ).toEqual(['JUSTIFICATION']);
  });
});

describe('regras de conservação (RN-AI-55 · entities.md §5.10)', () => {
  it('nova aplicação de IA troca a geração e zera a revisão (FA-02)', () => {
    const reviewed = filledSection('Texto', {
      ai: { ...pending(), reviewedAt: NOW.toISOString(), reviewedById: CARLA },
    });
    const reapplied = withAiApplied(reviewed, { generationId: G2, actorId: CARLA, now: NOW });
    expect(reapplied.ai).toEqual({
      generationId: G2,
      appliedAt: NOW.toISOString(),
      appliedById: CARLA,
      reviewedAt: null,
      reviewedById: null,
    });
    expect(isAiReviewPending(reapplied)).toBe(true);
  });

  it('editar o texto mantém a proveniência pendente (FA-01); esvaziar ou "não se aplica" limpa (FA-04)', () => {
    const section = filledSection('Texto', { ai: pending() });
    expect(aiAfterSave(section, 'FILLED')).toEqual(pending());
    expect(aiAfterSave(section, 'EMPTY')).toBeNull();
    expect(aiAfterSave(section, 'NOT_APPLICABLE')).toBeNull();
    expect(aiAfterSave(undefined, 'FILLED')).toBeNull();
    expect(aiAfterSave(filledSection('Manual'), 'FILLED')).toBeNull();
  });

  it('pendente só com proveniência sem revisão', () => {
    expect(isAiReviewPending(undefined)).toBe(false);
    expect(isAiReviewPending(filledSection('x'))).toBe(false);
    expect(isAiReviewPending(filledSection('x', { ai: null }))).toBe(false);
    expect(isAiReviewPending(filledSection('x', { ai: pending() }))).toBe(true);
  });
});
