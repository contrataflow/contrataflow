import { describe, expect, it } from 'vitest';

import { SECTION_ACTION_PROMPTS } from './prompts.js';
import { promptFingerprint } from '../../domain/prompts.js';
import { PROMPT_FINGERPRINTS } from '../prompt-fingerprints.js';

describe('prompts section.* (US-121 · RN-AI-06/47)', () => {
  it('uma chave por ação e o texto não muda sem nova versão (impressão digital travada)', () => {
    expect(
      Object.fromEntries(
        Object.entries(SECTION_ACTION_PROMPTS).map(([action, prompt]) => [action, prompt.key]),
      ),
    ).toEqual({
      REWRITE: 'section.rewrite',
      COMPLETE: 'section.complete',
      SUMMARIZE: 'section.summarize',
    });
    for (const prompt of Object.values(SECTION_ACTION_PROMPTS)) {
      expect(PROMPT_FINGERPRINTS[`${prompt.key}@${prompt.version}`]).toBe(
        promptFingerprint(prompt),
      );
    }
  });

  it('fixam as regras do ajuste: uma seção, fatos do texto atual intocados, [a confirmar] preservado', () => {
    for (const prompt of Object.values(SECTION_ACTION_PROMPTS)) {
      for (const rule of [
        'exatamente uma seção',
        'devem ser mantidos como estão',
        'Mantenha toda marcação [a confirmar',
        'nunca pelo nome',
      ]) {
        expect(prompt.instructions).toContain(rule);
      }
    }
    expect(SECTION_ACTION_PROMPTS.REWRITE.instructions).toContain('sem acrescentar fatos');
    expect(SECTION_ACTION_PROMPTS.COMPLETE.instructions).toContain('Preserve o texto atual');
    expect(SECTION_ACTION_PROMPTS.SUMMARIZE.instructions).toContain('nunca pode ser mais longo');
  });
});
