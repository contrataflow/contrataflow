import { z } from 'zod';

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
  quantityScale: 4,
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
});

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

/** Linha do corpo do DOC-07 (campos-base do DFD; ETP/TR acrescentam os seus com as stories). */
export const documentItemInputSchema = z.strictObject({
  processItemId: uuidV7Schema,
  /** Decimal como string (DEC-003): a forma é conferida aqui; a regra da unidade, no caso de uso. */
  quantity: z.string({ error: DOCUMENT_ITEM_MESSAGES.quantityRequired }).max(40),
  notes: z
    .string()
    .trim()
    .max(DOCUMENT_ITEM_LIMITS.notesMax, { error: DOCUMENT_ITEM_MESSAGES.notesLength })
    .nullable()
    .optional(),
  sortOrder: z.int().min(0).max(100_000).optional(),
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
  })
  .meta({ id: 'DocumentItem' });
export type DocumentItemDto = z.infer<typeof documentItemSchema>;
