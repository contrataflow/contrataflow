import { priceCompletionMessage, priceItemCompletionIssue } from '@contrataflow/validation';
import type { PriceResearchCompletedSummary, Violation } from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

import { totalEstimatedValueOf } from './price-calculation.js';
import type { PriceItem, PriceResearch } from './price-research.js';

/*
 * Conclusão da pesquisa de preços (US-032 · RN-PRICE-58..63). `PriceResearch.complete`: completude
 * de cada item (RN-PRICE-58/59), os valores propagados ao processo (RN-PRICE-61/62) e o cabeçalho
 * concluído (RN-PRICE-60). Puro: sem NestJS, Prisma nem outro módulo.
 */

/**
 * RN-PRICE-58/59: uma violação `BLOCKING` por item pendente, todas de uma vez, em `sortOrder`
 * (`itemId` = o `PriceItem`; `params.sequence` = nº do item no processo, para o rótulo da tela).
 * `sequences` traz o nº de cada item do processo (`sortOrder` na falta).
 */
export function completionViolations(
  items: readonly PriceItem[],
  sequences: ReadonlyMap<string, number>,
  minQuotations: number,
): Violation[] {
  return [...items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((item) => {
      const code = priceItemCompletionIssue(item, minQuotations);
      if (code === null) return [];
      const sequence = sequences.get(item.processItemId) ?? item.sortOrder;
      return [
        {
          code,
          severity: 'BLOCKING' as const,
          message: priceCompletionMessage(code, { ...item, sequence }),
          ruleId: 'RN-PRICE-58',
          sectionKey: null,
          field:
            code === 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED' ? 'belowMinimumJustification' : null,
          itemId: item.id,
          params: { sequence, processItemId: item.processItemId },
        },
      ];
    });
}

/**
 * RN-PRICE-61: o preço de referência do item — `manualUnitPrice` com o método `MANUAL`, senão o
 * `recommendedUnitPrice` calculado (Decimal(18,4)).
 */
export function referenceUnitPriceOf(item: PriceItem): string | null {
  const price =
    item.effectiveMethod === 'MANUAL' && item.manualUnitPrice !== null
      ? item.manualUnitPrice
      : item.recommendedUnitPrice;
  return price === null ? null : new Decimal(price).toFixed(4);
}

export interface CompletionReference {
  readonly unitPrices: readonly { readonly processItemId: string; readonly unitPrice: string }[];
  /** RN-PRICE-62: soma dos `totalPrice` (Decimal(18,2)). */
  readonly estimatedValue: string;
}

/** O que a conclusão propaga ao processo (só chamada com todos os itens completos). */
export function completionReference(items: readonly PriceItem[]): CompletionReference {
  return {
    unitPrices: items.flatMap((item) => {
      const unitPrice = referenceUnitPriceOf(item);
      return unitPrice === null ? [] : [{ processItemId: item.processItemId, unitPrice }];
    }),
    estimatedValue: totalEstimatedValueOf(items) ?? '0.00',
  };
}

/** RN-PRICE-60: o cabeçalho concluído (`completedAt`/`completedById`). */
export function completeResearch(
  research: PriceResearch,
  stamp: { readonly actorId: string; readonly now: Date },
): PriceResearch {
  return {
    ...research,
    completedAt: stamp.now,
    completedById: stamp.actorId,
    updatedAt: stamp.now,
    updatedById: stamp.actorId,
  };
}

/** RN-PRICE-63: `typedSummary` do `PriceResearchCompleted` — contadores e a marca de sigilo. */
export function completedSummary(
  research: Pick<PriceResearch, 'itemsCount' | 'itemsWithAlertsCount'>,
  isBudgetConfidential: boolean,
): PriceResearchCompletedSummary {
  return {
    totalEstimatedValueMasked: isBudgetConfidential,
    itemsCount: research.itemsCount,
    itemsWithAlertsCount: research.itemsWithAlertsCount,
  };
}
