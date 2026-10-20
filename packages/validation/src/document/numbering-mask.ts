/*
 * Máscara de numeração (DEC-028): `PT {seq:3}/{year}`. Funções puras, compartilhadas pela API
 * (`NUMBERING_MASK_INVALID`), pelo formulário do SCR-108 (US-061 · V-06) e pela SCR-041 (US-105).
 * Cada uso tem as suas regras (`NumberingMaskRules`): a máscara de um tipo de documento aceita
 * `{seq:1..8}` (RN-DOC-05); as chaves `numbering.*` aceitam `{seq:1..6}` e só as de documento
 * aceitam `{type}` (RN-TEN-67).
 */

export const NUMBERING_MASK_MAX_LENGTH = 60;
/** Padrão de `numbering.document.defaultMask` (entities.md §6). */
export const DEFAULT_DOCUMENT_NUMBERING_MASK = '{type} {seq:4}/{year}';
/** Padrão de `numbering.process.mask` (entities.md §6). */
export const DEFAULT_PROCESS_NUMBERING_MASK = '{seq:4}/{year}';
export const NUMBERING_MASK_MESSAGE =
  'A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.';

export interface NumberingMaskRules {
  /** Maior `N` aceito em `{seq:N}` (o menor é 1). */
  readonly maxSequenceWidth: number;
  /** `{type}` (código do tipo de documento) é aceito. */
  readonly allowType: boolean;
}

/** `DocumentType.numberingMask` (RN-DOC-05 · US-061). */
export const DOCUMENT_TYPE_MASK_RULES: NumberingMaskRules = {
  maxSequenceWidth: 8,
  allowType: true,
};

/** `numbering.process.mask` (RN-TEN-67 · US-105): sem `{type}`. */
export const PROCESS_MASK_RULES: NumberingMaskRules = { maxSequenceWidth: 6, allowType: false };

/** `numbering.document.defaultMask` e `numbering.document.<TYPE>.mask` (RN-TEN-67 · US-105). */
export const DOCUMENT_SETTING_MASK_RULES: NumberingMaskRules = {
  maxSequenceWidth: 6,
  allowType: true,
};

const TOKEN = /\{([^{}]*)\}/g;
const SEQ_TOKEN = /^seq:(\d)$/;

export type NumberingMaskProblem =
  | 'TOO_LONG'
  | 'MISSING_SEQ'
  | 'MISSING_YEAR'
  | 'DUPLICATE_TOKEN'
  | 'UNKNOWN_TOKEN'
  | 'TYPE_NOT_ALLOWED'
  | 'STRAY_BRACE';

/** Motivo da recusa, ou `null` se a máscara é válida pelas regras informadas. */
export function numberingMaskProblem(
  mask: string,
  rules: NumberingMaskRules = DOCUMENT_TYPE_MASK_RULES,
): NumberingMaskProblem | null {
  if (mask.length > NUMBERING_MASK_MAX_LENGTH) return 'TOO_LONG';
  let seq = 0;
  let year = 0;
  for (const match of mask.matchAll(TOKEN)) {
    const name = match[1] ?? '';
    const width = SEQ_TOKEN.exec(name)?.[1];
    if (width !== undefined) {
      // `{seq:0}`, `{seq:9}` e larguras acima do teto da regra são tokens desconhecidos.
      if (Number(width) < 1 || Number(width) > rules.maxSequenceWidth) return 'UNKNOWN_TOKEN';
      seq += 1;
    } else if (name === 'year') year += 1;
    else if (name === 'type') {
      if (!rules.allowType) return 'TYPE_NOT_ALLOWED';
    } else if (name !== 'org') return 'UNKNOWN_TOKEN';
  }
  // Chaves fora de um token completo (`{`/`}` soltas).
  const outsideTokens = mask.replace(TOKEN, '');
  if (outsideTokens.includes('{') || outsideTokens.includes('}')) return 'STRAY_BRACE';
  if (seq === 0) return 'MISSING_SEQ';
  if (year === 0) return 'MISSING_YEAR';
  if (seq > 1 || year > 1) return 'DUPLICATE_TOKEN';
  return null;
}

export function isValidNumberingMask(
  mask: string,
  rules: NumberingMaskRules = DOCUMENT_TYPE_MASK_RULES,
): boolean {
  return numberingMaskProblem(mask, rules) === null;
}

/** A máscara usa a sigla do órgão (`{org}`) — exigida com escopo `ORGANIZATION` (RN-TEN-67). */
export function maskHasOrganization(mask: string): boolean {
  return mask.includes('{org}');
}

/** Largura (1–8) do `{seq:N}` da máscara. */
export function sequenceWidth(mask: string): number {
  const match = /\{seq:([1-8])\}/.exec(mask);
  return match ? Number(match[1]) : 4;
}

export interface NumberingPreviewInput {
  readonly mask: string;
  /** Código do tipo para `{type}` (máscaras de documento). */
  readonly typeCode?: string;
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
    if (name === 'type') return input.typeCode ?? '';
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
