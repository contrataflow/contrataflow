import {
  DOCUMENT_ITEM_LIMITS,
  DOCUMENT_ITEM_MESSAGES,
  documentItemQuantityIssue,
  itemRichTextIssue,
  richTextFromPlainText,
  richTextPlainText,
} from '@contrataflow/validation';
import type { DocumentItemDto, DocumentItemInput, ProcessItemDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { quantityDecimal, quantityText } from '../etp/etp-estimates-model';

/*
 * Regras puras do painel "Itens" do TR (US-038 · SCR-012 · RN-TR-25/26): a lista combinada dos
 * itens ativos do processo (PRC-13) com as linhas do TR (DOC-06) — as incluídas primeiro, na ordem
 * do TR, depois as demais pelo nº do item —, o rascunho por linha (incluída, quantidade no formato
 * brasileiro, especificação, critérios de aceitação e observações como texto), a reordenação por
 * teclado (alternativa ao arrastar), a validação V-01 (a MESMA regra da API) e o corpo do DOC-07
 * (só as incluídas, na ordem; os textos só quando mudaram — vazio = `null`, limpa).
 */

export interface ItemRowDraft {
  readonly included: boolean;
  readonly quantity: string;
  readonly specification: string;
  readonly acceptanceCriteria: string;
  readonly notes: string;
}

/** Linha da tabela: o item do processo e, se incluído, a linha gravada no TR. */
export interface TermItemRow {
  readonly item: ProcessItemDto;
  readonly saved: DocumentItemDto | null;
}

export interface TermItemsState {
  /** Ids dos itens do processo na ordem exibida. */
  readonly order: readonly string[];
  readonly drafts: Readonly<Record<string, ItemRowDraft>>;
}

const textOf = (value: DocumentItemDto['specification']) =>
  value === null ? '' : richTextPlainText(value);

/** Rascunho de uma linha a partir do gravado (ou da quantidade de referência do item — US-037). */
function draftOf(item: ProcessItemDto, saved: DocumentItemDto | null): ItemRowDraft {
  if (saved === null) {
    return {
      included: false,
      quantity: item.referenceQuantity === null ? '' : quantityText(item.referenceQuantity),
      specification: '',
      acceptanceCriteria: '',
      notes: '',
    };
  }
  return {
    included: true,
    quantity: quantityText(saved.quantity),
    specification: textOf(saved.specification),
    acceptanceCriteria: textOf(saved.acceptanceCriteria),
    notes: saved.notes ?? '',
  };
}

/** Estado inicial: incluídas na ordem do TR (`sortOrder`), depois as demais pelo nº do item. */
export function termItemsStateOf(
  processItems: readonly ProcessItemDto[],
  documentItems: readonly DocumentItemDto[],
): TermItemsState {
  const savedById = new Map(documentItems.map((line) => [line.processItemId, line]));
  const included = [...documentItems]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((line) => line.processItemId)
    .filter((id) => processItems.some((item) => item.id === id));
  const rest = [...processItems]
    .filter((item) => !savedById.has(item.id))
    .sort((a, b) => a.sequence - b.sequence)
    .map((item) => item.id);
  const drafts: Record<string, ItemRowDraft> = {};
  for (const item of processItems) drafts[item.id] = draftOf(item, savedById.get(item.id) ?? null);
  return { order: [...included, ...rest], drafts };
}

/** As linhas na ordem exibida. */
export function termItemRows(
  state: TermItemsState,
  processItems: readonly ProcessItemDto[],
  documentItems: readonly DocumentItemDto[],
): TermItemRow[] {
  const byId = new Map(processItems.map((item) => [item.id, item]));
  const savedById = new Map(documentItems.map((line) => [line.processItemId, line]));
  return state.order.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [{ item, saved: savedById.get(id) ?? null }];
  });
}

/** FA-03 (teclado): move a linha uma posição para cima (`-1`) ou para baixo (`+1`). */
export function moveItem(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Ids incluídos, na ordem exibida (a ordem do corpo do DOC-07 e das mensagens `items[n]`). */
export function includedIds(state: TermItemsState): string[] {
  return state.order.filter((id) => state.drafts[id]?.included === true);
}

/** V-01/V-04 por linha incluída (`processItemId` → mensagem); vazio = pode salvar. */
export function termItemProblems(
  state: TermItemsState,
  documentItems: readonly DocumentItemDto[],
): Record<string, string> {
  const allowsDecimal = new Map(
    documentItems.map((line) => [line.processItemId, line.unit.allowsDecimal]),
  );
  const problems: Record<string, string> = {};
  for (const id of includedIds(state)) {
    const draft = state.drafts[id];
    if (draft === undefined) continue;
    const issue = documentItemQuantityIssue(
      quantityDecimal(draft.quantity),
      allowsDecimal.get(id) ?? true,
    );
    if (issue !== null) {
      problems[id] = issue.message;
      continue;
    }
    if (Array.from(draft.notes.trim()).length > DOCUMENT_ITEM_LIMITS.termNotesMax) {
      problems[id] = DOCUMENT_ITEM_MESSAGES.termNotesLength;
      continue;
    }
    for (const text of [draft.specification, draft.acceptanceCriteria]) {
      const textIssue = itemRichTextIssue(richTextFromPlainText(text));
      if (textIssue !== null) {
        problems[id] =
          textIssue === 'TOO_LONG'
            ? DOCUMENT_ITEM_MESSAGES.richTextTooLong
            : DOCUMENT_ITEM_MESSAGES.richTextTooLarge;
        break;
      }
    }
  }
  return problems;
}

/** Texto do rascunho → rich text do corpo: ausente se não mudou; vazio = `null` (limpa). */
function richTextField(
  draft: string,
  saved: DocumentItemDto['specification'] | undefined,
): DocumentItemInput['specification'] {
  if (draft === (saved === undefined ? '' : textOf(saved))) return undefined;
  return draft.trim() === '' ? null : richTextFromPlainText(draft);
}

/** Corpo do DOC-07: as incluídas na ordem exibida (`sortOrder` = posição). */
export function termItemsBody(
  state: TermItemsState,
  documentItems: readonly DocumentItemDto[],
): DocumentItemInput[] {
  const savedById = new Map(documentItems.map((line) => [line.processItemId, line]));
  return includedIds(state).map((id, index) => {
    const draft = state.drafts[id];
    const saved = savedById.get(id);
    const specification = richTextField(draft?.specification ?? '', saved?.specification);
    const acceptanceCriteria = richTextField(
      draft?.acceptanceCriteria ?? '',
      saved?.acceptanceCriteria,
    );
    const notes = draft?.notes.trim() ?? '';
    return {
      processItemId: id,
      quantity: quantityDecimal(draft?.quantity ?? ''),
      ...(notes === '' ? {} : { notes }),
      sortOrder: index,
      ...(specification === undefined ? {} : { specification }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    };
  });
}

/** Há alteração não salva (inclusão, remoção, ordem ou conteúdo)? */
export function termItemsDirty(
  state: TermItemsState,
  processItems: readonly ProcessItemDto[],
  documentItems: readonly DocumentItemDto[],
): boolean {
  const initial = termItemsStateOf(processItems, documentItems);
  if (includedIds(initial).join() !== includedIds(state).join()) return true;
  return includedIds(state).some((id) => {
    const a = initial.drafts[id];
    const b = state.drafts[id];
    if (a === undefined || b === undefined) return true;
    return (
      a.quantity !== b.quantity ||
      a.specification !== b.specification ||
      a.acceptanceCriteria !== b.acceptanceCriteria ||
      a.notes !== b.notes
    );
  });
}

/** Mensagens do 422 do DOC-07 por linha (`items[n].*` → a n-ésima incluída). */
export function termItemFieldErrorsOf(
  state: TermItemsState,
  error: unknown,
): Record<string, string> {
  if (!isApiError(error) || error.status !== 422) return {};
  const included = includedIds(state);
  const problems: Record<string, string> = {};
  for (const entry of error.errors) {
    const match = /^items\[(\d+)\]\./.exec(entry.field);
    const id = match === null ? undefined : included[Number(match[1])];
    if (id !== undefined) problems[id] ??= entry.message;
  }
  return problems;
}
