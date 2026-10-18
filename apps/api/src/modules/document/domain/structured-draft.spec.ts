import { richTextFromPlainText } from '@contrataflow/validation';
import type { DraftSection } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { draftContentFromSource, initialDraftContent } from './structured-draft.js';
import { sectionDefinition } from '../../../../test/support/document-fixtures.js';

const NOW = new Date('2026-10-17T15:00:00.000Z');

describe('initialDraftContent (US-014 · fluxo principal 4.5 · RN-DFD-07)', () => {
  it('todas as seções na ordem do template com revisão 1; estado derivado do conteúdo', () => {
    const draft = initialDraftContent(
      [
        sectionDefinition('NOTES', { order: 3 }),
        sectionDefinition('JUSTIFICATION', { order: 1 }),
        sectionDefinition('EXPECTED_RESULTS', {
          order: 2,
          defaultContent: richTextFromPlainText(
            'Atender a {{process.title}} em {{organization.name}}.',
          ),
        }),
        sectionDefinition('BLANK', { order: 4, defaultContent: richTextFromPlainText('   ') }),
      ],
      {
        actorId: 'u1',
        now: NOW,
        variables: { 'process.title': 'UBS Centro', 'organization.name': 'Prefeitura' },
      },
    );
    expect(Object.keys(draft.sections)).toEqual([
      'JUSTIFICATION',
      'EXPECTED_RESULTS',
      'NOTES',
      'BLANK',
    ]);
    expect(draft.sections.JUSTIFICATION).toEqual({
      state: 'EMPTY',
      content: null,
      justification: null,
      revision: 1,
      updatedAt: NOW.toISOString(),
      updatedById: 'u1',
    });
    expect(draft.sections.EXPECTED_RESULTS?.state).toBe('FILLED');
    expect(JSON.stringify(draft.sections.EXPECTED_RESULTS?.content)).toContain(
      'Atender a UBS Centro em Prefeitura.',
    );
    // Texto-base vazio não gera falsa completude (RN-DFD-31).
    expect(draft.sections.BLANK).toMatchObject({ state: 'EMPTY', content: null });
  });
});

type AiProvenance = NonNullable<DraftSection['ai']>;

describe('draftContentFromSource (US-018 · RN-DFD-78)', () => {
  const later = new Date('2026-10-18T09:00:00.000Z');
  const initial = initialDraftContent(
    [
      sectionDefinition('JUSTIFICATION', { order: 1 }),
      sectionDefinition('EXPECTED_RESULTS', { order: 2 }),
      sectionDefinition('NOTES', { order: 3 }),
    ],
    { actorId: 'bia', now: later, variables: {} },
  );
  const filled = (text: string, revision: number, ai?: AiProvenance) => ({
    state: 'FILLED' as const,
    content: richTextFromPlainText(text),
    justification: null,
    revision,
    updatedAt: NOW.toISOString(),
    updatedById: 'ana',
    ...(ai === undefined ? {} : { ai }),
  });

  it('copia o conteúdo por chave de seção com revisão 1 e o carimbo de quem duplicou; seção só do template fica inicial; seção só da origem some', () => {
    const draft = draftContentFromSource(
      initial,
      {
        sections: {
          JUSTIFICATION: filled('Reposição do estoque', 9),
          LEGACY: filled('Seção removida do modelo', 2),
        },
      },
      { actorId: 'bia', now: later },
    );
    expect(Object.keys(draft.sections)).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES']);
    expect(draft.sections.JUSTIFICATION).toMatchObject({
      state: 'FILLED',
      content: richTextFromPlainText('Reposição do estoque'),
      revision: 1,
      updatedAt: later.toISOString(),
      updatedById: 'bia',
    });
    expect(draft.sections.EXPECTED_RESULTS).toBe(initial.sections.EXPECTED_RESULTS);
  });

  it('a proveniência de IA é mantida, mas volta a exigir revisão humana', () => {
    const ai: AiProvenance = {
      generationId: 'g1',
      appliedAt: NOW.toISOString(),
      appliedById: 'ana',
      reviewedAt: NOW.toISOString(),
      reviewedById: 'ana',
    };
    const draft = draftContentFromSource(
      initial,
      { sections: { JUSTIFICATION: filled('Texto gerado', 3, ai) } },
      { actorId: 'bia', now: later },
    );
    expect(draft.sections.JUSTIFICATION?.ai).toMatchObject({
      reviewedAt: null,
      reviewedById: null,
    });
  });
});
