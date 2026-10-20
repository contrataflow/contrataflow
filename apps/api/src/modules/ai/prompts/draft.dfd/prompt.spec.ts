import { describe, expect, it } from 'vitest';

import { DFD_DRAFT_PROMPT } from './prompt.js';
import { promptFingerprint } from '../../domain/prompts.js';
import { PROMPT_FINGERPRINTS } from '../prompt-fingerprints.js';

describe('prompt draft.dfd (US-117 · RN-AI-06)', () => {
  it('o texto não muda sem nova versão (impressão digital travada)', () => {
    expect(DFD_DRAFT_PROMPT.key).toBe('draft.dfd');
    expect(PROMPT_FINGERPRINTS[`draft.dfd@${DFD_DRAFT_PROMPT.version}`]).toBe(
      promptFingerprint(DFD_DRAFT_PROMPT),
    );
  });

  it('fixa as regras do DFD: guia do modelo, dados intocados, pessoas por papel e seção opcional', () => {
    for (const rule of [
      'guia de redação do modelo',
      'não os altere',
      'nunca pelo nome',
      'Seção opcional sem informação',
    ]) {
      expect(DFD_DRAFT_PROMPT.instructions).toContain(rule);
    }
  });
});
