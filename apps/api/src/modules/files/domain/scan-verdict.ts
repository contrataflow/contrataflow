import type { AttachmentReasonCode } from '@contrataflow/types';

/*
 * Resultado do antivírus (US-068 · RN-DOC-76 · storage.md §5.3 item 4): `OK` → limpo; `FOUND` →
 * `INFECTED`, exceto as heurísticas de POLÍTICA do clamd, que viram `REJECTED` com motivo próprio
 * (conteúdo criptografado, limites de varredura excedidos e macros OLE2). Arquivo além dos limites
 * nunca é "limpo por omissão" (`AlertExceedsMax yes`).
 */

export type AntivirusResult =
  { readonly clean: true } | { readonly clean: false; readonly signature: string };

export interface Finding {
  readonly status: 'INFECTED' | 'REJECTED';
  readonly reasonCode: AttachmentReasonCode;
}

const POLICY_HEURISTICS: readonly (readonly [RegExp, AttachmentReasonCode])[] = [
  [/^Heuristics\.Encrypted\./i, 'ENCRYPTED_CONTENT'],
  [/^Heuristics\.Limits\.Exceeded/i, 'SCAN_LIMITS_EXCEEDED'],
  [/^Heuristics\.OLE2\.ContainsMacros/i, 'MACRO_CONTENT'],
];

export function classifyFinding(signature: string): Finding {
  for (const [pattern, reasonCode] of POLICY_HEURISTICS) {
    if (pattern.test(signature)) return { status: 'REJECTED', reasonCode };
  }
  return { status: 'INFECTED', reasonCode: 'INFECTED' };
}
