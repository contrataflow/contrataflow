import { richTextFromPlainText } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { initialDraftContent } from './structured-draft.js';
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
