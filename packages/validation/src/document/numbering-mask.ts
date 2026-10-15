/*
 * Máscara de numeração de documentos (RN-DOC-05 · DEC-028 · US-061): `PT {seq:3}/{year}`. Função
 * pura, compartilhada pela API (`NUMBERING_MASK_INVALID`) e pelo formulário do SCR-108 (V-06).
 */

export const NUMBERING_MASK_MAX_LENGTH = 60;
/** Padrão de `numbering.document.defaultMask` (entities.md §6). */
export const DEFAULT_DOCUMENT_NUMBERING_MASK = '{type} {seq:4}/{year}';
export const NUMBERING_MASK_MESSAGE =
  'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.';

const TOKEN = /\{([^{}]*)\}/g;
const SEQ_TOKEN = /^seq:([1-8])$/;
const PLAIN_TOKENS: ReadonlySet<string> = new Set(['year', 'org', 'type']);

export type NumberingMaskProblem =
  'TOO_LONG' | 'MISSING_SEQ' | 'MISSING_YEAR' | 'DUPLICATE_TOKEN' | 'UNKNOWN_TOKEN' | 'STRAY_BRACE';

/** Motivo da recusa, ou `null` se a máscara é válida. */
export function numberingMaskProblem(mask: string): NumberingMaskProblem | null {
  if (mask.length > NUMBERING_MASK_MAX_LENGTH) return 'TOO_LONG';
  let seq = 0;
  let year = 0;
  for (const match of mask.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    if (SEQ_TOKEN.test(name)) seq += 1;
    else if (name === 'year') year += 1;
    else if (!PLAIN_TOKENS.has(name)) return 'UNKNOWN_TOKEN';
  }
  // Chaves fora de um token completo (`{`/`}` soltas).
  const outsideTokens = mask.replace(TOKEN, '');
  if (outsideTokens.includes('{') || outsideTokens.includes('}')) return 'STRAY_BRACE';
  if (seq === 0) return 'MISSING_SEQ';
  if (year === 0) return 'MISSING_YEAR';
  if (seq > 1 || year > 1) return 'DUPLICATE_TOKEN';
  return null;
}

export function isValidNumberingMask(mask: string): boolean {
  return numberingMaskProblem(mask) === null;
}

/** Largura (1–8) do `{seq:N}` da máscara. */
export function sequenceWidth(mask: string): number {
  const match = /\{seq:([1-8])\}/.exec(mask);
  return match ? Number(match[1]) : 4;
}

export interface NumberingPreviewInput {
  readonly mask: string;
  readonly typeCode: string;
  readonly sequence: number;
  readonly year: number;
  /** Sigla do órgão para `{org}`. */
  readonly organization?: string;
}

/** Aplica a máscara (prévia do próximo número: "PT 001/2026"). */
export function renderNumberingMask(input: NumberingPreviewInput): string {
  const width = sequenceWidth(input.mask);
  return input.mask.replace(TOKEN, (_token, name: string) => {
    if (name === 'year') return String(input.year);
    if (name === 'type') return input.typeCode;
    if (name === 'org') return input.organization ?? '';
    return String(input.sequence).padStart(width, '0');
  });
}

/** Sugestão de código a partir do nome ("Parecer técnico" → `PARECER_TECNICO`). */
export function suggestDocumentTypeCode(name: string): string {
  const code = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefixed = code === '' || /^[A-Z]/.test(code) ? code : `T_${code}`;
  return prefixed.slice(0, 40);
}
