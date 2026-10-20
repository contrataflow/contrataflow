import { z } from 'zod';

import { RICH_TEXT_MAX_BYTES, richTextPlainText, richTextProblem } from './rich-text.js';
import type { RichTextDocValue } from './rich-text.js';
import { quantitySchema } from '../common/decimal.js';
import { uuidV7Schema } from '../common/identifiers.js';

/*
 * Itens de documento (US-014 · DEC-019 · entities.md `DocumentItem` · api/03-documents.md DOC-06/07):
 * a linha de um documento tipado (DFD, ETP, TR) que referencia um `ProcessItem` do mesmo processo
 * com a quantidade daquele documento. O DOC-07 substitui a coleção inteira (com `If-Match` do
 * documento); a regra da quantidade (V-09 — > 0, até 4 casas, inteira quando a unidade não admite
 * decimais) é a MESMA no wizard e na API (`documentItemQuantityIssue`).
 */

export const DOCUMENT_ITEM_LIMITS = Object.freeze({
  /** Linhas por documento: o mesmo teto dos itens do processo (RN-PROC-83). */
  itemsMax: 1000,
  notesMax: 1000,
  /** TR (US-038 · RN-TR-26): observações do item até 5.000 caracteres. */
  termNotesMax: 5000,
  quantityScale: 4,
  /** TR (US-038 · RN-TR-26): especificação e critérios de aceitação até 50.000 caracteres. */
  richTextCharsMax: 50_000,
});

export const DOCUMENT_ITEM_MESSAGES = Object.freeze({
  quantityRequired: 'Informe uma quantidade maior que zero.',
  quantityPositive: 'Informe uma quantidade maior que zero.',
  quantityDecimal: 'Informe uma quantidade com até 4 casas decimais.',
  quantityInteger: 'Esta unidade aceita apenas números inteiros.',
  notesLength: `As observações do item devem ter no máximo ${DOCUMENT_ITEM_LIMITS.notesMax.toLocaleString('pt-BR')} caracteres.`,
  itemInvalid: 'Selecione itens deste processo, sem repetição.',
  itemsLimit: `O documento pode ter no máximo ${DOCUMENT_ITEM_LIMITS.itemsMax.toLocaleString('pt-BR')} itens.`,
  conflict: 'Os itens foram alterados por outra pessoa. Atualizamos a lista.',
  /** US-022 · V-03 (RN-ETP-27): memória de cálculo fora do schema ou acima de 1 MB. */
  calculationMemoInvalid: 'O conteúdo da memória de cálculo é inválido ou excede o limite.',
  calculationMemoTooLarge: 'Reduza o conteúdo da memória de cálculo.',
  /** US-038 · V-02/V-04 (RN-TR-26). */
  duplicate: 'Este item já está na lista.',
  termNotesLength: `As observações do item devem ter no máximo ${DOCUMENT_ITEM_LIMITS.termNotesMax.toLocaleString('pt-BR')} caracteres.`,
  richTextInvalid: 'Conteúdo não suportado no editor.',
  richTextTooLarge: 'Reduza o conteúdo do texto do item (limite de 1 MB).',
  richTextTooLong: `O texto deve ter no máximo ${DOCUMENT_ITEM_LIMITS.richTextCharsMax.toLocaleString('pt-BR')} caracteres.`,
});

/** Campos ricos do item do TR (US-038 · RN-TR-26). */
export const DOCUMENT_ITEM_RICH_TEXT_FIELDS = ['specification', 'acceptanceCriteria'] as const;
export type DocumentItemRichTextField = (typeof DOCUMENT_ITEM_RICH_TEXT_FIELDS)[number];

/** Problema de especificação/critérios de aceitação do item (RN-TR-26 · V-04); `null` = aceito. */
export type ItemRichTextIssue = CalculationMemoIssue | 'TOO_LONG';

/**
 * RN-TR-26 · DEC-056: rich text opcional, até 1 MB serializado (`PAYLOAD_TOO_LARGE`), só com os
 * nós/marks permitidos (`RICH_TEXT_INVALID`) e até 50.000 caracteres de texto (`TOO_LONG`). A
 * MESMA regra no editor e na API.
 */
export function itemRichTextIssue(value: unknown): ItemRichTextIssue | null {
  const issue = calculationMemoIssue(value);
  if (issue !== null || value === null || value === undefined) return issue;
  const text = richTextPlainText(value as RichTextDocValue);
  return Array.from(text).length > DOCUMENT_ITEM_LIMITS.richTextCharsMax ? 'TOO_LONG' : null;
}

/** Problema da memória de cálculo do item do ETP (RN-ETP-27 · V-03); `null` = aceita. */
export type CalculationMemoIssue = 'RICH_TEXT_INVALID' | 'PAYLOAD_TOO_LARGE';

/**
 * RN-ETP-27 · DEC-056: a memória de cálculo é rich text opcional, até 1 MB serializado
 * (`PAYLOAD_TOO_LARGE` — conferido antes do schema, para não percorrer um corpo enorme) e só com os
 * nós/marks permitidos (`RICH_TEXT_INVALID`). A MESMA regra no editor (bloqueia novos caracteres —
 * FA-06) e na API.
 */
export function calculationMemoIssue(memo: unknown): CalculationMemoIssue | null {
  if (memo === null || memo === undefined) return null;
  if (calculationMemoBytes(memo) > RICH_TEXT_MAX_BYTES) return 'PAYLOAD_TOO_LARGE';
  return richTextProblem(memo) === null ? null : 'RICH_TEXT_INVALID';
}

/** Tamanho serializado (UTF-8) da memória de cálculo — o limite de 1 MB (DEC-056). */
export function calculationMemoBytes(memo: unknown): number {
  if (memo === null || memo === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(memo)).length;
}

/** Problema de uma quantidade (V-09): código do campo e mensagem; `null` = válida. */
export interface QuantityIssue {
  readonly code: 'REQUIRED' | 'OUT_OF_RANGE' | 'INVALID_DECIMAL';
  readonly message: string;
}

const QUANTITY_PATTERN = /^\d{1,14}(?:\.\d+)?$/;

/**
 * V-09 / FA-11: quantidade como string decimal com ponto. Vazia → `REQUIRED`; ≤ 0 →
 * `OUT_OF_RANGE`; mais de 4 casas ou formato inválido → `INVALID_DECIMAL`; fracionária para
 * unidade sem decimais (`metadata.allowsDecimal = false`, ex.: `UN`, `CX`) → `INVALID_DECIMAL`.
 */
export function documentItemQuantityIssue(
  quantity: string | null | undefined,
  allowsDecimal: boolean,
): QuantityIssue | null {
  const value = quantity?.trim() ?? '';
  if (value === '') return { code: 'REQUIRED', message: DOCUMENT_ITEM_MESSAGES.quantityRequired };
  if (!QUANTITY_PATTERN.test(value)) {
    return { code: 'INVALID_DECIMAL', message: DOCUMENT_ITEM_MESSAGES.quantityDecimal };
  }
  const [, fraction = ''] = value.split('.');
  if (fraction.length > DOCUMENT_ITEM_LIMITS.quantityScale) {
    return { code: 'INVALID_DECIMAL', message: DOCUMENT_ITEM_MESSAGES.quantityDecimal };
  }
  if (Number(value) <= 0) {
    return { code: 'OUT_OF_RANGE', message: DOCUMENT_ITEM_MESSAGES.quantityPositive };
  }
  if (!allowsDecimal && /[1-9]/.test(fraction)) {
    return { code: 'INVALID_DECIMAL', message: DOCUMENT_ITEM_MESSAGES.quantityInteger };
  }
  return null;
}

/** Quantidade normalizada com 4 casas (`"120"` → `"120.0000"`), como `numeric(18,4)` a devolve. */
export function normalizeQuantity(quantity: string): string {
  const [integer = '0', fraction = ''] = quantity.trim().split('.');
  const digits = integer.replace(/^0+(?=\d)/, '');
  return `${digits}.${fraction.padEnd(DOCUMENT_ITEM_LIMITS.quantityScale, '0')}`;
}

// --- Contratos ---------------------------------------------------------------------------------

const itemRichTextInput = z
  .looseObject({ type: z.string() })
  .nullable()
  .optional()
  .meta({ description: 'TipTapDoc (DEC-056), até 50.000 caracteres e 1 MB; `null` limpa.' });

/** Linha do corpo do DOC-07 (campos-base do DFD; ETP/TR acrescentam os seus com as stories). */
export const documentItemInputSchema = z.strictObject({
  processItemId: uuidV7Schema,
  /** Decimal como string (DEC-003): a forma é conferida aqui; a regra da unidade, no caso de uso. */
  quantity: z.string({ error: DOCUMENT_ITEM_MESSAGES.quantityRequired }).max(40),
  /** ≤ 1.000 (DFD/ETP) ou ≤ 5.000 (TR — RN-TR-26): o teto do tipo é conferido no caso de uso. */
  notes: z
    .string()
    .trim()
    .max(DOCUMENT_ITEM_LIMITS.termNotesMax, { error: DOCUMENT_ITEM_MESSAGES.termNotesLength })
    .nullable()
    .optional(),
  sortOrder: z.int().min(0).max(100_000).optional(),
  /**
   * ETP (US-022 · RN-ETP-27): memória de cálculo em rich text (TipTap, ≤ 1 MB). Ausente = mantém a
   * gravada; `null` = limpa. O schema do conteúdo é conferido no caso de uso (422
   * `RICH_TEXT_INVALID`/413 `PAYLOAD_TOO_LARGE`).
   */
  calculationMemo: z
    .looseObject({ type: z.string() })
    .nullable()
    .optional()
    .meta({ description: 'TipTapDoc (DEC-056), até 1 MB serializado; `null` limpa.' }),
  /**
   * TR (US-038 · RN-TR-26): especificação e critérios de aceitação em rich text. Ausente = mantém o
   * gravado; `null` = limpa. Conferidos no caso de uso (413 `PAYLOAD_TOO_LARGE`, 422
   * `RICH_TEXT_INVALID`, 422 `TOO_LONG` acima de 50.000 caracteres).
   */
  specification: itemRichTextInput,
  acceptanceCriteria: itemRichTextInput,
});
export type DocumentItemInput = z.infer<typeof documentItemInputSchema>;

/** DOC-07 — `PUT /documents/{id}/items` (substituição completa; `If-Match` do documento). */
export const documentItemsReplaceSchema = z
  .strictObject({
    items: z
      .array(documentItemInputSchema)
      .max(DOCUMENT_ITEM_LIMITS.itemsMax, { error: DOCUMENT_ITEM_MESSAGES.itemsLimit }),
  })
  .meta({ id: 'DocumentItemsReplace' });
export type DocumentItemsReplace = z.infer<typeof documentItemsReplaceSchema>;

/** Linha do DOC-06/07 (resposta): o item do processo com a quantidade deste documento. */
export const documentItemSchema = z
  .object({
    processItemId: z.uuid(),
    /** Nº do item no processo (RN-PROC-73). */
    sequence: z.int(),
    description: z.string(),
    unit: z.object({
      id: z.uuid(),
      label: z.string(),
      /** `metadata.allowsDecimal` da unidade (FA-11). */
      allowsDecimal: z.boolean(),
    }),
    quantity: quantitySchema,
    notes: z.string().nullable(),
    sortOrder: z.int(),
    /** ETP (US-022 · RN-ETP-27): memória de cálculo (TipTapDoc) ou `null`. */
    calculationMemo: z
      .looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).optional() })
      .nullable(),
    /** TR (US-038 · RN-TR-26): especificação (TipTapDoc) ou `null`. */
    specification: z
      .looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).optional() })
      .nullable(),
    /** TR (US-038 · RN-TR-26): critérios de aceitação (TipTapDoc) ou `null`. */
    acceptanceCriteria: z
      .looseObject({ type: z.literal('doc'), content: z.array(z.unknown()).optional() })
      .nullable(),
  })
  .meta({ id: 'DocumentItem' });
export type DocumentItemDto = z.infer<typeof documentItemSchema>;
