import { describe, expect, it } from 'vitest';

import { ETP_DRAFT_PROMPT } from './prompt.js';
import { promptFingerprint } from '../../domain/prompts.js';
import { PROMPT_FINGERPRINTS } from '../prompt-fingerprints.js';

describe('prompt draft.etp (US-118 · RN-AI-06)', () => {
  it('o texto não muda sem nova versão (impressão digital travada)', () => {
    expect(ETP_DRAFT_PROMPT.key).toBe('draft.etp');
    expect(PROMPT_FINGERPRINTS[`draft.etp@${ETP_DRAFT_PROMPT.version}`]).toBe(
      promptFingerprint(ETP_DRAFT_PROMPT),
    );
  });

  it('fixa as regras do ETP: a IA não decide, valor só da pesquisa e seções estruturadas (RN-AI-35..37)', () => {
    for (const rule of [
      'A IA não decide',
      '[a confirmar: conclusão sobre a viabilidade]',
      '[a confirmar: solução escolhida]',
      '[a confirmar: decisão sobre o parcelamento]',
      '[a confirmar: valor estimado da pesquisa de preços]',
      'Nunca use o custo de uma alternativa',
      'texto complementar',
      'nunca pelo nome',
    ]) {
      expect(ETP_DRAFT_PROMPT.instructions).toContain(rule);
    }
  });
});
