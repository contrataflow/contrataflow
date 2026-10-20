import { describe, expect, it } from 'vitest';

import { TERM_DRAFT_PROMPT } from './prompt.js';
import { promptFingerprint } from '../../domain/prompts.js';
import { PROMPT_FINGERPRINTS } from '../prompt-fingerprints.js';

describe('prompt draft.tr (US-120 · RN-AI-06)', () => {
  it('o texto não muda sem nova versão (impressão digital travada)', () => {
    expect(TERM_DRAFT_PROMPT.key).toBe('draft.tr');
    expect(PROMPT_FINGERPRINTS[`draft.tr@${TERM_DRAFT_PROMPT.version}`]).toBe(
      promptFingerprint(TERM_DRAFT_PROMPT),
    );
  });

  it('fixa as regras do TR: condições só dos campos tipados, sem multa inventada e valor só da pesquisa (RN-AI-44..46)', () => {
    for (const rule of [
      'só podem vir das condições contratuais do TR',
      '[a confirmar: prazo de pagamento]',
      '[a confirmar: local de entrega]',
      'Não crie percentual nem valor de multa',
      'Preserve as citações legais',
      '[a confirmar: valor estimado da pesquisa de preços]',
      '[a confirmar: dotação orçamentária]',
      'texto complementar',
      'nunca pelo nome',
    ]) {
      expect(TERM_DRAFT_PROMPT.instructions).toContain(rule);
    }
  });
});
