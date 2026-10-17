/*
 * Impressões digitais travadas dos prompts (RN-AI-06): `<promptKey>@<promptVersion>` → SHA-256 do
 * texto (comum + instruções). Mudou o texto? Crie nova `promptVersion` e acrescente a linha — o
 * teste `prompts.spec.ts` reprova texto alterado com a versão antiga. Nunca edite uma linha
 * existente: a versão antiga continua citada pelas gerações gravadas.
 */
export const PROMPT_FINGERPRINTS: Readonly<Record<string, string>> = {
  'common@1.0.0': '6c22ec95afab46c3e827079891ae69e6749a423b73f48034c03bcde3c9e24d57',
};
