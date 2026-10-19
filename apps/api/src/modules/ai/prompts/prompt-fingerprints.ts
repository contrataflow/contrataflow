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
  'section.rewrite@1.0.0': 'c5e8c7003a310de93a48ac9c53ed6c5a7c15513766929b656b2926b5d7086209',
  'section.complete@1.0.0': '3bc22b5601b3c60d1acbb5f7f6c03dc3d499e8c5248f6f833b98b6ec8e7791c3',
  'section.summarize@1.0.0': '4990e212bd00f00967384e4d7835df34b2ed41d8855acc11136a90421e451d3a',
};
