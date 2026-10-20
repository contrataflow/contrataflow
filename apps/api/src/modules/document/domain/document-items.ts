import {
  DOCUMENT_ITEM_LIMITS,
  DOCUMENT_ITEM_MESSAGES,
  documentItemQuantityIssue,
  normalizeQuantity,
} from '@contrataflow/validation';
import type { DocumentItemInput, FieldError, RichTextDocValue } from '@contrataflow/validation';

import { canonicalJson } from '#shared/integrity/canonical-json.js';

/*
 * Itens de documento (US-014 · DEC-019 · RN-DFD-14 · DOC-07): a coleção do documento tipado é
 * SUBSTITUÍDA inteira — cada linha referencia um item não excluído do mesmo processo, uma única vez,
 * com quantidade > 0, até 4 casas e inteira quando a unidade não admite decimais (V-09/V-10). O
 * diff (incluídos, removidos, quantidades alteradas) alimenta a auditoria `document.items_update`.
 * US-022: a linha do ETP leva a memória de cálculo (RN-ETP-27 — rich text ≤ 1 MB); ausente no corpo
 * mantém a gravada (o id e o `sortOrder` da linha também se preservam), `null` limpa. Puro: a
 * leitura dos itens do processo e das unidades é da aplicação. US-038 (TR): especificação e critérios
 * de aceitação em rich text com a mesma semântica da memória (ausente mantém, `null` limpa), o teto
 * das observações por tipo (`notesMax`) e o diff dos textos (só hash + tamanho na auditoria).
 */

export interface DocumentItem {
  readonly id: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly processItemId: string;
  /** Decimal(18,4) como string com 4 casas (`"120.0000"`). */
  readonly quantity: string;
  readonly notes: string | null;
  readonly sortOrder: number;
  /** ETP (US-022 · RN-ETP-27): memória de cálculo em rich text; `null` = sem memória. */
  readonly calculationMemo: RichTextDocValue | null;
  /** TR (US-038 · RN-TR-26): especificação em rich text; `null` = sem especificação. */
  readonly specification: RichTextDocValue | null;
  /** TR (US-038 · RN-TR-26): critérios de aceitação em rich text. */
  readonly acceptanceCriteria: RichTextDocValue | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
}

/** Item do processo disponível para o documento (não excluído, do mesmo processo). */
export interface AvailableProcessItem {
  readonly processItemId: string;
  /** `metadata.allowsDecimal` da unidade do item (FA-11). */
  readonly allowsDecimal: boolean;
}

export interface DocumentItemsChange {
  readonly processItemId: string;
  readonly old: string | null;
  readonly new: string | null;
}

/** Memória de cálculo alterada (na auditoria, só hash + tamanho — story · "Auditoria"). */
export interface CalculationMemoChange {
  readonly processItemId: string;
  readonly old: RichTextDocValue | null;
  readonly new: RichTextDocValue | null;
}

/** Especificação/critérios de aceitação alterados (US-038 — na auditoria, só hash + tamanho). */
export interface ItemTextChange {
  readonly processItemId: string;
  readonly field: 'specification' | 'acceptanceCriteria';
  readonly old: RichTextDocValue | null;
  readonly new: RichTextDocValue | null;
}

export interface DocumentItemsPlan {
  readonly items: DocumentItem[];
  /** Erros por campo (`items[n].processItemId`/`items[n].quantity`) — 422 `VALIDATION_ERROR`. */
  readonly errors: FieldError[];
  /** Quantidades antes/depois por item (`null` = incluído/removido). */
  readonly changes: DocumentItemsChange[];
  /** Memórias de cálculo alteradas (incluídas, trocadas ou limpas). */
  readonly memoChanges: CalculationMemoChange[];
  /** Especificações e critérios de aceitação alterados (TR — US-038). */
  readonly textChanges: ItemTextChange[];
}

/** Igualdade estrutural de duas memórias (o `jsonb` devolve as chaves em outra ordem). */
function sameMemo(a: RichTextDocValue | null, b: RichTextDocValue | null): boolean {
  if (a === null || b === null) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

export interface PlanDocumentItemsInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly current: readonly DocumentItem[];
  readonly next: readonly DocumentItemInput[];
  readonly available: ReadonlyMap<string, AvailableProcessItem>;
  readonly actorId: string;
  readonly now: Date;
  readonly newId: () => string;
  /** Teto das observações do tipo (DFD/ETP 1.000 · TR 5.000 — RN-TR-26); padrão 1.000. */
  readonly notesMax?: number;
}

const TEXT_FIELDS = ['specification', 'acceptanceCriteria'] as const;

/** Ausente = mantém o gravado; `null` limpa (RN-ETP-27 · RN-TR-26). */
function keptOrNew(
  value: unknown,
  existing: RichTextDocValue | null | undefined,
): RichTextDocValue | null {
  return value === undefined ? (existing ?? null) : (value as RichTextDocValue | null);
}

/** RN-DFD-14 · V-09/V-10: a nova coleção, os erros por linha e o diff. */
export function planDocumentItems(input: PlanDocumentItemsInput): DocumentItemsPlan {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const currentByItem = new Map(input.current.map((item) => [item.processItemId, item]));
  const items: DocumentItem[] = [];

  input.next.forEach((line, index) => {
    const at = `items[${String(index)}]`;
    const available = input.available.get(line.processItemId);
    if (available === undefined) {
      errors.push({
        field: `${at}.processItemId`,
        code: 'REFERENCE_NOT_FOUND',
        message: DOCUMENT_ITEM_MESSAGES.itemInvalid,
      });
      return;
    }
    if (seen.has(line.processItemId)) {
      errors.push({
        field: `${at}.processItemId`,
        code: 'DUPLICATE_IN_LIST',
        message: DOCUMENT_ITEM_MESSAGES.duplicate,
      });
      return;
    }
    seen.add(line.processItemId);
    const issue = documentItemQuantityIssue(line.quantity, available.allowsDecimal);
    if (issue !== null) {
      errors.push({ field: `${at}.quantity`, code: issue.code, message: issue.message });
      return;
    }
    const notes = line.notes?.trim() ? line.notes.trim() : null;
    const notesMax = input.notesMax ?? DOCUMENT_ITEM_LIMITS.notesMax;
    if (notes !== null && Array.from(notes).length > notesMax) {
      errors.push({
        field: `${at}.notes`,
        code: 'TOO_LONG',
        message:
          notesMax === DOCUMENT_ITEM_LIMITS.notesMax
            ? DOCUMENT_ITEM_MESSAGES.notesLength
            : DOCUMENT_ITEM_MESSAGES.termNotesLength,
      });
      return;
    }
    const existing = currentByItem.get(line.processItemId);
    const quantity = normalizeQuantity(line.quantity);
    const sortOrder = line.sortOrder ?? index;
    // Ausente = mantém a memória gravada; `null` limpa (RN-ETP-27).
    const calculationMemo = keptOrNew(line.calculationMemo, existing?.calculationMemo);
    const specification = keptOrNew(line.specification, existing?.specification);
    const acceptanceCriteria = keptOrNew(line.acceptanceCriteria, existing?.acceptanceCriteria);
    const unchanged =
      existing?.quantity === quantity &&
      existing.notes === notes &&
      existing.sortOrder === sortOrder &&
      sameMemo(existing.calculationMemo, calculationMemo) &&
      sameMemo(existing.specification, specification) &&
      sameMemo(existing.acceptanceCriteria, acceptanceCriteria);
    items.push(
      existing !== undefined && unchanged
        ? existing
        : {
            id: existing?.id ?? input.newId(),
            tenantId: input.tenantId,
            documentId: input.documentId,
            processItemId: line.processItemId,
            quantity,
            notes,
            sortOrder,
            calculationMemo,
            specification,
            acceptanceCriteria,
            createdAt: existing?.createdAt ?? input.now,
            updatedAt: input.now,
            createdById: existing?.createdById ?? input.actorId,
            updatedById: input.actorId,
          },
    );
  });

  const nextByItem = new Map(items.map((item) => [item.processItemId, item]));
  const changes: DocumentItemsChange[] = [];
  const memoChanges: CalculationMemoChange[] = [];
  const textChanges: ItemTextChange[] = [];
  for (const item of items) {
    const previous = currentByItem.get(item.processItemId);
    const before = previous?.quantity ?? null;
    if (before !== item.quantity) {
      changes.push({ processItemId: item.processItemId, old: before, new: item.quantity });
    }
    const memoBefore = previous?.calculationMemo ?? null;
    if (!sameMemo(memoBefore, item.calculationMemo)) {
      memoChanges.push({
        processItemId: item.processItemId,
        old: memoBefore,
        new: item.calculationMemo,
      });
    }
    for (const field of TEXT_FIELDS) {
      const textBefore = previous?.[field] ?? null;
      if (!sameMemo(textBefore, item[field])) {
        textChanges.push({
          processItemId: item.processItemId,
          field,
          old: textBefore,
          new: item[field],
        });
      }
    }
  }
  for (const item of input.current) {
    if (!nextByItem.has(item.processItemId)) {
      changes.push({ processItemId: item.processItemId, old: item.quantity, new: null });
    }
  }
  return { items, errors, changes, memoChanges, textChanges };
}
