/*
 * Impressões digitais travadas dos prompts (RN-AI-06): `<promptKey>@<promptVersion>` → SHA-256 do
 * texto (comum + instruções). Mudou o texto? Crie nova `promptVersion` e acrescente a linha — o
 * teste `prompts.spec.ts` reprova texto alterado com a versão antiga. Nunca edite uma linha
 * existente: a versão antiga continua citada pelas gerações gravadas.
 */
export const PROMPT_FINGERPRINTS: Readonly<Record<string, string>> = {
  'common@1.0.0': '6c22ec95afab46c3e827079891ae69e6749a423b73f48034c03bcde3c9e24d57',
  'draft.dfd@1.0.0': 'bec3941474d65b09aa90f69c5f46007c5359cf41c8eea02382369094c02269b0',
  'draft.risk_map@1.0.0': '30e06bfa8357aa08dae1b0f7760c6b38736af547dd8cf19ef16bf0cfc5928387',
};
