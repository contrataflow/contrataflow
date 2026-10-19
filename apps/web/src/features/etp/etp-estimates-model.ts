import {
  calculationMemoBytes,
  documentItemQuantityIssue,
  ETP_ESTIMATE_MESSAGES,
  RICH_TEXT_MAX_BYTES,
  richTextFromPlainText,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  DocumentItemDto,
  DocumentItemInput,
  EtpDetailDto,
  EtpEstimatedValueSource,
  EtpUpdate,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { formatMoneyText, toDecimalMoney } from '../processes/money';

/*
 * Regras puras da seção "Estimativas" do ETP (US-022 · SCR-008): o rascunho por item (quantidade no
 * formato brasileiro + memória de cálculo como texto), o corpo do DOC-07 (coleção inteira; a memória
 * só vai quando mudou — ausente, a API mantém a gravada), a validação V-01/V-02 (as mesmas regras
 * da API — `documentItemQuantityIssue`), o limite de 1 MB da memória (FA-06), o painel "Valor
 * estimado" (V-04/V-05 e o corpo do ETP-04) e a situação do valor (vinculado, aguardando cálculo —
 * FA-03 —, desatualizado — FA-04 —, manual, indefinido ou sigiloso — FA-05).
 */

/** Rascunho de uma linha: quantidade digitada ("12,5") e memória como texto. */
export interface EstimateRowDraft {
  readonly quantity: string;
  readonly memo: string;
}

/** `"500.0000"` → `"500"`; `"12.5000"` → `"12,5"` (exibição brasileira, sem zeros à direita). */
export function quantityText(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole},${trimmed}`;
}

/** Texto digitado → string decimal com ponto para a API ("1.234,5" → "1234.5"). */
export function quantityDecimal(text: string): string {
  const clean = text.trim();
  return clean.includes(',') ? clean.replaceAll('.', '').replace(',', '.') : clean;
}

const memoText = (item: DocumentItemDto) =>
  item.calculationMemo === null ? '' : richTextPlainText(item.calculationMemo);

/** O rascunho inicial de cada item, pela resposta do DOC-06. */
export function estimateDraftsOf(
  items: readonly DocumentItemDto[],
): Record<string, EstimateRowDraft> {
  return Object.fromEntries(
    items.map((item) => [
      item.processItemId,
      { quantity: quantityText(item.quantity), memo: memoText(item) },
    ]),
  );
}

/** Há alteração não salva em alguma linha? */
export function estimatesDirty(
  items: readonly DocumentItemDto[],
  drafts: Readonly<Record<string, EstimateRowDraft>>,
): boolean {
  const initial = estimateDraftsOf(items);
  return items.some((item) => {
    const draft = drafts[item.processItemId];
    const base = initial[item.processItemId];
    return draft !== undefined && (draft.quantity !== base?.quantity || draft.memo !== base.memo);
  });
}

/** V-01/V-02 por item (`processItemId` → mensagem); vazio = pode salvar. */
export function estimateRowProblems(
  items: readonly DocumentItemDto[],
  drafts: Readonly<Record<string, EstimateRowDraft>>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const item of items) {
    const draft = drafts[item.processItemId];
    if (draft === undefined) continue;
    const issue = documentItemQuantityIssue(
      quantityDecimal(draft.quantity),
      item.unit.allowsDecimal,
    );
    if (issue !== null) problems[item.processItemId] = issue.message;
  }
  return problems;
}

/** FA-06: a memória digitada cabe no limite de 1 MB (DEC-056)? */
export function memoFits(text: string): boolean {
  return calculationMemoBytes(richTextFromPlainText(text)) <= RICH_TEXT_MAX_BYTES;
}

/**
 * Corpo do DOC-07: a coleção inteira, na ordem do documento (preserva ids e `sortOrder` no
 * servidor); a memória só quando o texto mudou (vazio = `null`, limpa).
 */
export function estimateItemsBody(
  items: readonly DocumentItemDto[],
  drafts: Readonly<Record<string, EstimateRowDraft>>,
): DocumentItemInput[] {
  return items.map((item) => {
    const draft = drafts[item.processItemId];
    const quantity = draft === undefined ? item.quantity : quantityDecimal(draft.quantity);
    const line: DocumentItemInput = {
      processItemId: item.processItemId,
      quantity,
      ...(item.notes === null ? {} : { notes: item.notes }),
      sortOrder: item.sortOrder,
    };
    if (draft === undefined || draft.memo === memoText(item)) return line;
    return {
      ...line,
      calculationMemo: draft.memo.trim() === '' ? null : richTextFromPlainText(draft.memo),
    };
  });
}

/** "Ver diferenças" do 412: as quantidades que divergem da versão salva (seq., minha, servidor). */
export function estimateConflictRows(
  mine: readonly DocumentItemDto[],
  drafts: Readonly<Record<string, EstimateRowDraft>>,
  server: readonly DocumentItemDto[],
): { readonly sequence: number; readonly mine: string; readonly server: string }[] {
  const byItem = new Map(server.map((item) => [item.processItemId, item]));
  return mine.flatMap((item) => {
    const saved = byItem.get(item.processItemId);
    const draft = drafts[item.processItemId]?.quantity ?? quantityText(item.quantity);
    const current = saved === undefined ? '—' : quantityText(saved.quantity);
    return draft === current ? [] : [{ sequence: item.sequence, mine: draft, server: current }];
  });
}

/** Mensagens do 422 do DOC-07 por item (`items[n].quantity` → a linha `n`). */
export function estimateFieldErrorsOf(
  items: readonly DocumentItemDto[],
  error: unknown,
): Record<string, string> {
  if (!isApiError(error) || error.status !== 422) return {};
  const problems: Record<string, string> = {};
  for (const entry of error.errors) {
    const match = /^items\[(\d+)\]\./.exec(entry.field);
    const item = match === null ? undefined : items[Number(match[1])];
    if (item !== undefined) problems[item.processItemId] ??= entry.message;
  }
  return problems;
}

// --- Valor estimado (ETP-04) --------------------------------------------------------------------

export interface EstimateValueForm {
  readonly source: EtpEstimatedValueSource | null;
  /** Valor manual digitado ("125.000,00"). */
  readonly money: string;
  readonly priceResearchId: string;
}

/** O formulário inicial: a origem atual e, para FA-02, o último valor como ponto de partida. */
export function estimateValueFormOf(
  etp: Pick<EtpDetailDto, 'estimatedValueSource' | 'estimatedTotalValue' | 'priceResearchId'>,
  activeResearchId: string | null,
): EstimateValueForm {
  return {
    source: etp.estimatedValueSource,
    money: etp.estimatedTotalValue === null ? '' : formatMoneyText(etp.estimatedTotalValue),
    priceResearchId: etp.priceResearchId ?? activeResearchId ?? '',
  };
}

export type EstimateValueCheck =
  | { readonly ok: true; readonly body: EtpUpdate }
  | {
      readonly ok: false;
      readonly field: 'source' | 'money' | 'priceResearchId';
      readonly message: string;
    };

/** V-04/V-05 e o corpo do ETP-04 (as mesmas regras de `etpEstimateIssues` na API). */
export function estimateValueBody(form: EstimateValueForm): EstimateValueCheck {
  if (form.source === null) {
    return { ok: false, field: 'source', message: ETP_ESTIMATE_MESSAGES.sourceRequired };
  }
  if (form.source === 'MANUAL') {
    if (form.money.trim() === '') {
      return { ok: false, field: 'money', message: ETP_ESTIMATE_MESSAGES.valueRequired };
    }
    const value = toDecimalMoney(form.money);
    if (value === null) {
      return { ok: false, field: 'money', message: ETP_ESTIMATE_MESSAGES.valueInvalid };
    }
    return { ok: true, body: { estimatedValueSource: 'MANUAL', estimatedTotalValue: value } };
  }
  if (form.priceResearchId === '') {
    return {
      ok: false,
      field: 'priceResearchId',
      message: ETP_ESTIMATE_MESSAGES.priceResearchRequired,
    };
  }
  return {
    ok: true,
    body: { estimatedValueSource: 'PRICE_RESEARCH', priceResearchId: form.priceResearchId },
  };
}

/** Situação do valor estimado exibida no painel (`aria-live`). */
export type EstimateValueStatus =
  | { readonly kind: 'masked' }
  | { readonly kind: 'undefined' }
  | { readonly kind: 'awaiting' }
  | { readonly kind: 'stale'; readonly value: string }
  | { readonly kind: 'linked'; readonly value: string }
  | { readonly kind: 'manual'; readonly value: string };

export function estimateValueStatus(
  etp: Pick<
    EtpDetailDto,
    'estimatedValueSource' | 'estimatedTotalValue' | 'estimatedTotalValueMasked'
  >,
): EstimateValueStatus {
  if (etp.estimatedTotalValueMasked) return { kind: 'masked' };
  const value = etp.estimatedTotalValue;
  if (etp.estimatedValueSource === 'PRICE_RESEARCH') {
    return value === null ? { kind: 'awaiting' } : { kind: 'linked', value };
  }
  if (value === null) return { kind: 'undefined' };
  // FA-04: valor sem origem — o vínculo foi desfeito pelo cancelamento da pesquisa.
  return etp.estimatedValueSource === null ? { kind: 'stale', value } : { kind: 'manual', value };
}

/** Problema do salvamento (itens ou valor) para a mensagem da tela. */
export type EstimateProblem =
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'message';
      readonly key: 'forbidden' | 'notEditable' | 'unavailable' | 'memoInvalid' | 'formErrors';
    }
  | { readonly kind: 'detail'; readonly message: string }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function estimateProblemOf(error: unknown): EstimateProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  if (error.status === 412 || error.status === 428) return { kind: 'conflict' };
  if (error.status === 403) return { kind: 'message', key: 'forbidden' };
  if (error.code === 'DOCUMENT_NOT_EDITABLE') return { kind: 'message', key: 'notEditable' };
  if (error.status === 503 || error.status === 429) return { kind: 'message', key: 'unavailable' };
  if (error.code === 'RICH_TEXT_INVALID' || error.status === 413) {
    return { kind: 'message', key: 'memoInvalid' };
  }
  if (error.status === 422) {
    const first = error.errors[0];
    return first === undefined
      ? { kind: 'detail', message: error.problem?.detail ?? error.message }
      : { kind: 'message', key: 'formErrors' };
  }
  if (error.status === 409)
    return { kind: 'detail', message: error.problem?.detail ?? error.message };
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
