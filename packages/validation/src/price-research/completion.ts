import { z } from 'zod';

import { priceResearchSchema } from './price-research.js';
import { DOCUMENT_STATUSES } from '../document/document-type.js';

/*
 * Conclusão da pesquisa de preços (US-032 · api/07 PRS-23 · RN-PRICE-58..63). Concluir é finalizar o
 * `Document` do tipo `PRICE_RESEARCH` (DEC-018). As regras de completude por item, as mensagens e os
 * contratos servem à API (PRS-23, PRS-07 e o `DocumentValidator` do DOC-08/10) e à SCR-009 (diálogo
 * de confirmação e lista de pendências).
 */

/** RN-PRICE-59: violações de completude (prefixo `PRICE_*` — api.md §2.1.2; dona: US-032). */
export const PRICE_COMPLETION_VIOLATION_CODES = [
  'PRICE_ITEM_WITHOUT_PRICE',
  'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED',
] as const;
export type PriceCompletionViolationCode = (typeof PRICE_COMPLETION_VIOLATION_CODES)[number];

/** Justificativa de cotações insuficientes (RN-PRICE-58): o mesmo mínimo da justificativa manual. */
export const BELOW_MINIMUM_JUSTIFICATION_MIN = 20;
export const BELOW_MINIMUM_JUSTIFICATION_MAX = 4000;

/** Rótulo do item nas mensagens: "Item 2" (nº do item no processo). */
export function priceItemLabel(sequence: number): string {
  return `Item ${String(sequence)}`;
}

export const PRICE_COMPLETION_MESSAGES = Object.freeze({
  // V-01/V-02 (por item).
  withoutPrice: (item: string) =>
    `O item "${item}" não tem preço calculado. Registre cotações ou um valor manual.`,
  noValidQuotes: (item: string) =>
    `O item "${item}" não tem cotação válida. Registre ao menos uma cotação válida.`,
  belowMinimum: (item: string) =>
    `O item "${item}" tem menos cotações que o mínimo exigido. Informe a justificativa.`,
  // "Casos de erro".
  incomplete: 'Há itens pendentes. Revise antes de concluir a pesquisa.',
  incompleteWithoutPrice: 'Há itens sem preço definido. Revise antes de concluir.',
  incompleteBelowMinimum: 'Há itens com cotações insuficientes sem justificativa.',
  notEditable: 'Esta pesquisa já foi concluída ou não pode ser concluída agora.',
  preconditionRequired: 'Recarregue a página e tente novamente.',
  versionConflict: 'Esta pesquisa foi alterada por outra pessoa. Recarregue para revisar.',
  permissionDenied: 'Você não tem permissão para concluir esta pesquisa.',
  inProgress: 'Estamos concluindo a pesquisa. Aguarde.',
  unavailable: 'Não foi possível concluir agora. Tente novamente em instantes.',
  // SCR-009.
  justificationTooShort: `Informe a justificativa com ao menos ${String(BELOW_MINIMUM_JUSTIFICATION_MIN)} caracteres.`,
  withAlerts: (count: number) =>
    count === 1
      ? 'Esta pesquisa será concluída com 1 item com alerta.'
      : `Esta pesquisa será concluída com ${String(count)} itens com alerta.`,
  completed: (value: string) =>
    `Pesquisa de preços concluída — valor estimado atualizado para ${value}`,
  confidentialValue: 'Sigiloso',
});

/** O que a regra de completude lê de cada `PriceItem` (RN-PRICE-58). */
export interface PriceItemCompletionFacts {
  readonly recommendedUnitPrice: string | null;
  readonly validQuotationsCount: number;
  readonly belowMinimumJustification: string | null;
}

/**
 * RN-PRICE-58 (um item): `recommendedUnitPrice` definido (calculado ou manual) **e** (`válidas ≥
 * mínimo` **ou** justificativa preenchida). Sem nenhuma cotação válida o item sempre bloqueia —
 * nenhuma justificativa (nem o valor manual) substitui a ausência total de cotação válida.
 * `null` = item completo.
 */
export function priceItemCompletionIssue(
  item: PriceItemCompletionFacts,
  minQuotations: number,
): PriceCompletionViolationCode | null {
  if (item.recommendedUnitPrice === null || item.validQuotationsCount === 0) {
    return 'PRICE_ITEM_WITHOUT_PRICE';
  }
  if (
    item.validQuotationsCount < minQuotations &&
    (item.belowMinimumJustification?.trim() ?? '') === ''
  ) {
    return 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED';
  }
  return null;
}

/** A mensagem da violação do item (V-01/V-02). */
export function priceCompletionMessage(
  code: PriceCompletionViolationCode,
  item: PriceItemCompletionFacts & { readonly sequence: number },
): string {
  const label = priceItemLabel(item.sequence);
  if (code === 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED') {
    return PRICE_COMPLETION_MESSAGES.belowMinimum(label);
  }
  return item.recommendedUnitPrice !== null && item.validQuotationsCount === 0
    ? PRICE_COMPLETION_MESSAGES.noValidQuotes(label)
    : PRICE_COMPLETION_MESSAGES.withoutPrice(label);
}

/**
 * PRS-07: a justificativa de cotações insuficientes, quando informada, tem de 20 a 4.000 caracteres
 * (sem os espaços das pontas); `null`/vazio apaga. `null` = válida.
 */
export function belowMinimumJustificationIssue(text: string | null | undefined): string | null {
  const value = text?.trim() ?? '';
  if (value === '') return null;
  return value.length < BELOW_MINIMUM_JUSTIFICATION_MIN
    ? PRICE_COMPLETION_MESSAGES.justificationTooShort
    : null;
}

// --- Contratos (PRS-23) --------------------------------------------------------------------------

/** PRS-23 — `POST /price-research/{id}/complete` (corpo `{}`; `If-Match` + `Idempotency-Key`). */
export const completePriceResearchSchema = z
  .strictObject({})
  .meta({ id: 'PriceResearchCompleteRequest' });

/** Resposta do PRS-23: a pesquisa concluída com o documento `FINALIZED` e a versão criada. */
export const completedPriceResearchSchema = priceResearchSchema
  .extend({
    document: z.object({
      status: z.enum(DOCUMENT_STATUSES),
      currentVersionId: z.uuid().nullable(),
    }),
  })
  .meta({ id: 'CompletedPriceResearch' });
export type CompletedPriceResearchDto = z.infer<typeof completedPriceResearchSchema>;

/**
 * `typedSummary` do `PriceResearchCompleted` (`DocumentFinalized` de `PRICE_RESEARCH` — RN-PRICE-63 ·
 * events.md): só contadores e a marca de sigilo, nunca o valor (DEC-030).
 */
export interface PriceResearchCompletedSummary {
  readonly totalEstimatedValueMasked: boolean;
  readonly itemsCount: number;
  readonly itemsWithAlertsCount: number;
}
