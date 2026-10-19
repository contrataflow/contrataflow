import {
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
 * leitura dos itens do processo e das unidades é da aplicação.
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

export interface DocumentItemsPlan {
  readonly items: DocumentItem[];
  /** Erros por campo (`items[n].processItemId`/`items[n].quantity`) — 422 `VALIDATION_ERROR`. */
  readonly errors: FieldError[];
  /** Quantidades antes/depois por item (`null` = incluído/removido). */
  readonly changes: DocumentItemsChange[];
  /** Memórias de cálculo alteradas (incluídas, trocadas ou limpas). */
  readonly memoChanges: CalculationMemoChange[];
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
        message: DOCUMENT_ITEM_MESSAGES.itemInvalid,
      });
      return;
    }
    seen.add(line.processItemId);
    const issue = documentItemQuantityIssue(line.quantity, available.allowsDecimal);
    if (issue !== null) {
      errors.push({ field: `${at}.quantity`, code: issue.code, message: issue.message });
      return;
    }
    const existing = currentByItem.get(line.processItemId);
    const quantity = normalizeQuantity(line.quantity);
    const notes = line.notes?.trim() ? line.notes.trim() : null;
    const sortOrder = line.sortOrder ?? index;
    // Ausente = mantém a memória gravada; `null` limpa (RN-ETP-27).
    const calculationMemo =
      line.calculationMemo === undefined
        ? (existing?.calculationMemo ?? null)
        : (line.calculationMemo as RichTextDocValue | null);
    const unchanged =
      existing?.quantity === quantity &&
      existing.notes === notes &&
      existing.sortOrder === sortOrder &&
      sameMemo(existing.calculationMemo, calculationMemo);
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
  }
  for (const item of input.current) {
    if (!nextByItem.has(item.processItemId)) {
      changes.push({ processItemId: item.processItemId, old: item.quantity, new: null });
    }
  }
  return { items, errors, changes, memoChanges };
}
