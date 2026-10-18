import { describe, expect, it } from 'vitest';

import { RISK_MAP_DRAFT_PROMPT } from './prompt.js';
import { promptFingerprint } from '../../domain/prompts.js';
import { PROMPT_FINGERPRINTS } from '../prompt-fingerprints.js';

describe('prompt draft.risk_map (US-119 · RN-AI-06)', () => {
  it('o texto não muda sem nova versão (impressão digital travada)', () => {
    expect(RISK_MAP_DRAFT_PROMPT.key).toBe('draft.risk_map');
    expect(PROMPT_FINGERPRINTS[`draft.risk_map@${RISK_MAP_DRAFT_PROMPT.version}`]).toBe(
      promptFingerprint(RISK_MAP_DRAFT_PROMPT),
    );
  });

  it('fixa as regras do mapa: até 15 riscos, sem duplicar, sem responsável/prazo/valor', () => {
    for (const rule of [
      'de 1 a 15 riscos',
      'Não repita riscos já registrados',
      'similarToRiskCode',
      'Nunca indique responsável, prazo, data ou valor',
      'nunca pelo nome',
    ]) {
      expect(RISK_MAP_DRAFT_PROMPT.instructions).toContain(rule);
    }
  });
});
