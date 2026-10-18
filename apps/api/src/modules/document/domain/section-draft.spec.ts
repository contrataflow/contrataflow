import type { DraftSection, RichTextDoc } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  applySectionDraft,
  isIdenticalSave,
  sectionDraftProblem,
  sectionDraftValue,
  sectionValueHash,
} from './section-draft.js';

const doc = (text: string): RichTextDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const NOW = new Date('2026-10-17T15:00:00.000Z');
const ACTOR = '0192d015-0000-7000-8000-0000000000c1';

const section = (overrides: Partial<DraftSection> = {}): DraftSection => ({
  state: 'FILLED',
  content: doc('Texto atual') as DraftSection['content'],
  justification: null,
  revision: 3,
  updatedAt: '2026-10-17T14:00:00.000Z',
  updatedById: '0192d015-0000-7000-8000-0000000000c2',
  ...overrides,
});

const input = (
  content: RichTextDoc | null,
  notApplicable = false,
  justification: string | null = null,
) => ({
  content,
  notApplicable,
  justification,
});

describe('SectionDraft (US-015 · RN-DFD-31/36)', () => {
  describe('sectionDraftProblem', () => {
    it('aceita conteúdo válido, nulo e no limite de maxChars', () => {
      expect(sectionDraftProblem(input(doc('ok')), { maxChars: 50_000 })).toBeNull();
      expect(sectionDraftProblem(input(null), { maxChars: 10 })).toBeNull();
      expect(sectionDraftProblem(input(doc('a'.repeat(10))), { maxChars: 10 })).toBeNull();
    });

    it('TOO_LONG acima de maxChars (texto puro)', () => {
      expect(sectionDraftProblem(input(doc('a'.repeat(11))), { maxChars: 10 })).toEqual({
        kind: 'TOO_LONG',
        maxChars: 10,
      });
    });

    it('RICH_TEXT_INVALID com nó fora do schema do editor', () => {
      const problem = sectionDraftProblem(input({ type: 'doc', content: [{ type: 'script' }] }), {
        maxChars: 50_000,
      });
      expect(problem).toMatchObject({ kind: 'RICH_TEXT_INVALID' });
    });

    it('PAYLOAD_TOO_LARGE acima de 1 MB serializado, antes de percorrer o schema', () => {
      const huge: RichTextDoc = {
        type: 'doc',
        content: [{ type: 'unknown', attrs: { blob: 'x'.repeat(1024 * 1024) } }],
      };
      expect(sectionDraftProblem(input(huge), { maxChars: 50_000 })).toEqual({
        kind: 'PAYLOAD_TOO_LARGE',
      });
    });

    it('"não se aplica" exige justificativa de 20+ caracteres (US-020)', () => {
      expect(sectionDraftProblem(input(null, true), { maxChars: 10 })).toEqual({
        kind: 'JUSTIFICATION_REQUIRED',
      });
      expect(sectionDraftProblem(input(null, true, 'curta'), { maxChars: 10 })).toEqual({
        kind: 'JUSTIFICATION_TOO_SHORT',
      });
      expect(
        sectionDraftProblem(input(null, true, 'Não há resultados mensuráveis aqui.'), {
          maxChars: 10,
        }),
      ).toBeNull();
    });
  });

  describe('sectionDraftValue', () => {
    it('FILLED com texto útil; EMPTY (conteúdo nulo) com só espaços', () => {
      expect(sectionDraftValue(input(doc('Algo')))).toMatchObject({ state: 'FILLED' });
      expect(sectionDraftValue(input(doc('   ')))).toEqual({
        state: 'EMPTY',
        content: null,
        justification: null,
      });
    });

    it('NOT_APPLICABLE guarda a justificativa aparada; fora dele a justificativa é descartada', () => {
      expect(sectionDraftValue(input(null, true, '  Justificativa longa o bastante  '))).toEqual({
        state: 'NOT_APPLICABLE',
        content: null,
        justification: 'Justificativa longa o bastante',
      });
      expect(sectionDraftValue(input(doc('Algo'), false, 'ignorada')).justification).toBeNull();
    });
  });

  describe('isIdenticalSave (RN-DFD-36)', () => {
    it('mesmo conteúdo e estado → no-op; conteúdo diferente ou seção ausente → grava', () => {
      const previous = section();
      expect(isIdenticalSave(previous, sectionDraftValue(input(doc('Texto atual'))))).toBe(true);
      expect(isIdenticalSave(previous, sectionDraftValue(input(doc('Outro'))))).toBe(false);
      expect(isIdenticalSave(undefined, sectionDraftValue(input(doc('Texto atual'))))).toBe(false);
    });

    it('o hash não depende da ordem das chaves do JSON', () => {
      const a = sectionValueHash({
        state: 'FILLED',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        justification: null,
      });
      const b = sectionValueHash({
        justification: null,
        content: { content: [{ type: 'paragraph' }], type: 'doc' },
        state: 'FILLED',
      });
      expect(a).toBe(b);
    });
  });

  describe('applySectionDraft', () => {
    it('revisão + 1, carimbo e estado derivado; seção ausente parte da revisão 0', () => {
      const next = applySectionDraft(section(), sectionDraftValue(input(doc('Novo'))), {
        actorId: ACTOR,
        now: NOW,
      });
      expect(next).toMatchObject({
        state: 'FILLED',
        revision: 4,
        updatedAt: NOW.toISOString(),
        updatedById: ACTOR,
      });
      expect(next).not.toHaveProperty('ai');
      expect(
        applySectionDraft(undefined, sectionDraftValue(input(null)), { actorId: ACTOR, now: NOW })
          .revision,
      ).toBe(1);
    });

    it('mantém a proveniência de IA ao editar e a limpa ao esvaziar (US-122)', () => {
      const ai = {
        generationId: '0192d015-0000-7000-8000-0000000000d1',
        appliedAt: NOW.toISOString(),
        appliedById: ACTOR,
        reviewedAt: null,
        reviewedById: null,
      };
      const previous = section({ ai });
      expect(
        applySectionDraft(previous, sectionDraftValue(input(doc('Editado'))), {
          actorId: ACTOR,
          now: NOW,
        }).ai,
      ).toEqual(ai);
      expect(
        applySectionDraft(previous, sectionDraftValue(input(null)), { actorId: ACTOR, now: NOW })
          .ai,
      ).toBeNull();
    });
  });
});
