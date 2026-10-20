import {
  PRICE_COMPLETION_MESSAGES,
  belowMinimumJustificationIssue,
  priceCompletionMessage,
  priceItemCompletionIssue,
} from '@contrataflow/validation';
import type {
  PriceCompletionViolationCode,
  PriceItemDto,
  PriceResearchDto,
  Violation,
} from '@contrataflow/validation';

import { formatMoney } from '@/lib/i18n/format';

/*
 * Regras de tela da conclusão da pesquisa (US-032 · SCR-009), puras e testáveis: a prévia do diálogo
 * de confirmação (as MESMAS regras de completude do PRS-23 — RN-PRICE-58 — e a contagem de alertas
 * do FA-03), as pendências devolvidas pelo 422 para a lista com links e o texto do toast de sucesso
 * (POL-09: "Sigiloso"). A tela nunca decide sozinha: o PRS-23 confere tudo de novo.
 */

/** Uma pendência de item: o código, a mensagem e o item da pesquisa (para o link). */
export interface PendingItem {
  readonly itemId: string;
  readonly sequence: number;
  readonly code: PriceCompletionViolationCode;
  readonly message: string;
}

export interface CompletionPreview {
  readonly pending: readonly PendingItem[];
  /** Itens com algum alerta (não bloqueiam — FA-03). */
  readonly itemsWithAlerts: number;
}

/** A prévia do diálogo "Concluir pesquisa" sobre os itens carregados. */
export function completionPreview(
  items: readonly PriceItemDto[],
  minQuotations: number,
): CompletionPreview {
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    pending: sorted.flatMap((item) => {
      const code = priceItemCompletionIssue(item, minQuotations);
      return code === null
        ? []
        : [
            {
              itemId: item.id,
              sequence: item.sequence,
              code,
              message: priceCompletionMessage(code, item),
            },
          ];
    }),
    itemsWithAlerts: items.filter((item) => item.alerts.length > 0).length,
  };
}

const isCompletionCode = (code: string): code is PriceCompletionViolationCode =>
  code === 'PRICE_ITEM_WITHOUT_PRICE' || code === 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED';

/** `violations[]` do 422 `PRICE_RESEARCH_INCOMPLETE` → a lista de pendências (com o nº do item). */
export function pendingFromViolations(
  violations: readonly Violation[],
  items: readonly PriceItemDto[],
): PendingItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return violations.flatMap((violation) => {
    if (!isCompletionCode(violation.code) || violation.itemId === null) return [];
    const sequence =
      typeof violation.params.sequence === 'number'
        ? violation.params.sequence
        : (byId.get(violation.itemId)?.sequence ?? 0);
    return [
      { itemId: violation.itemId, sequence, code: violation.code, message: violation.message },
    ];
  });
}

/** O toast de sucesso: o valor atualizado, ou "Sigiloso" sob POL-09. */
export function completedToast(research: PriceResearchDto): string {
  const value =
    research.totalEstimatedValueMasked || research.totalEstimatedValue === null
      ? PRICE_COMPLETION_MESSAGES.confidentialValue
      : formatMoney(research.totalEstimatedValue);
  return PRICE_COMPLETION_MESSAGES.completed(value);
}

/** Mostrar o campo de justificativa: abaixo do mínimo (com alguma válida) ou já justificado. */
export function needsBelowMinimumJustification(item: PriceItemDto, minQuotations: number): boolean {
  return (
    item.belowMinimumJustification !== null ||
    (item.validQuotationsCount > 0 && item.validQuotationsCount < minQuotations)
  );
}

/** A justificativa digitada: `null` = válida (vazia apaga); senão a mensagem. */
export function justificationIssue(text: string): string | null {
  return belowMinimumJustificationIssue(text);
}
