import { describe, expect, it } from 'vitest';

import {
  AI_SECTION_MIN_CHARS,
  aiSectionAdjustProblem,
  sectionHasNarrative,
  sectionTextLength,
} from './section-adjust.js';

const TEXT = { render: 'TEXT', allowNarrative: false } as const;
const long = 'a'.repeat(AI_SECTION_MIN_CHARS);

describe('ajuste de seção com IA — elegibilidade (US-121 · RN-AI-48 · V-02/V-03)', () => {
  it('narrativa: TEXT sempre; estruturada só com allowNarrative', () => {
    expect(sectionHasNarrative(TEXT)).toBe(true);
    expect(sectionHasNarrative({ render: 'ITEMS_TABLE', allowNarrative: true })).toBe(true);
    expect(sectionHasNarrative({ render: 'ITEMS_TABLE', allowNarrative: false })).toBe(false);
  });

  it('conta caracteres sem os espaços das pontas', () => {
    expect(sectionTextLength('  ação  ')).toBe(4);
  });

  it('REWRITE/SUMMARIZE exigem 50 caracteres; COMPLETE aceita seção vazia', () => {
    for (const action of ['REWRITE', 'SUMMARIZE'] as const) {
      expect(
        aiSectionAdjustProblem({ action, section: TEXT, state: 'FILLED', text: 'a'.repeat(49) }),
      ).toBe('AI_SECTION_EMPTY');
      expect(aiSectionAdjustProblem({ action, section: TEXT, state: 'FILLED', text: long })).toBe(
        null,
      );
    }
    expect(
      aiSectionAdjustProblem({ action: 'COMPLETE', section: TEXT, state: 'EMPTY', text: '' }),
    ).toBe(null);
  });

  it('fora do template, sem narrativa ou "não se aplica" → AI_SECTION_NOT_SUPPORTED', () => {
    const base = { action: 'COMPLETE', state: 'FILLED', text: long } as const;
    expect(aiSectionAdjustProblem({ ...base, section: null })).toBe('AI_SECTION_NOT_SUPPORTED');
    expect(
      aiSectionAdjustProblem({
        ...base,
        section: { render: 'RISK_MATRIX', allowNarrative: false },
      }),
    ).toBe('AI_SECTION_NOT_SUPPORTED');
    expect(aiSectionAdjustProblem({ ...base, section: TEXT, state: 'NOT_APPLICABLE' })).toBe(
      'AI_SECTION_NOT_SUPPORTED',
    );
  });
});
