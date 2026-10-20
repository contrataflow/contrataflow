import { createHash } from 'node:crypto';

/*
 * Valores do processo na auditoria (US-001 `process.create` · US-005 `process.update`): textos
 * longos entram como hash + tamanho, nunca o texto (story · "Auditoria").
 */

/** Campos de texto longo do processo: na auditoria, só hash + tamanho. */
export const LONG_TEXT_FIELDS = [
  'title',
  'object',
  'description',
  'notes',
  'pcaJustification',
] as const;

const LONG_TEXT = new Set<string>(LONG_TEXT_FIELDS);

export function fingerprint(text: string): { readonly sha256: string; readonly length: number } {
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Array.from(text).length,
  };
}

/** O valor como a auditoria o grava: texto longo → `{ sha256, length }`; demais, o próprio valor. */
export function auditedValue(field: string, value: unknown): unknown {
  return LONG_TEXT.has(field) && typeof value === 'string' ? fingerprint(value) : value;
}
