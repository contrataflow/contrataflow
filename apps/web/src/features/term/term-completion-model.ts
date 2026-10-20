import type { TermTemplateSectionDto, Violation } from '@contrataflow/validation';

/*
 * Regras de tela do painel "Completude do TR" (US-039 · SCR-012), puras e testadas: para onde cada
 * pendência do DOC-08 leva — a seção do rascunho ou o painel do campo ("Itens", "Condições
 * contratuais", "Dados do TR") — e o resumo bloqueantes × avisos.
 */

export type TermPanelKey = 'items' | 'conditions' | 'general';

/** Destino do link de uma pendência. */
export type CompletionTarget =
  | { readonly kind: 'section'; readonly key: string }
  | { readonly kind: 'panel'; readonly panel: TermPanelKey; readonly field: string }
  | { readonly kind: 'none' };

/** Campo do cabeçalho/itens → painel que o edita (US-036/US-038). */
const PANEL_OF_FIELD: Readonly<Record<string, TermPanelKey>> = {
  items: 'items',
  estimatedTotalValue: 'general',
  estimatedValueSource: 'general',
  objectDefinition: 'general',
  contractDurationMonths: 'conditions',
  executionDeadline: 'conditions',
  executionDeadlineType: 'conditions',
  deliveryLocation: 'conditions',
  paymentTermDays: 'conditions',
  productWarrantyMonths: 'conditions',
  contractGuaranteePercent: 'conditions',
  allowsSubcontracting: 'conditions',
  selectionCriterionId: 'conditions',
  awardType: 'conditions',
};

export function completionTargetOf(
  violation: Pick<Violation, 'sectionKey' | 'field'>,
  sections: readonly Pick<TermTemplateSectionDto, 'key'>[],
): CompletionTarget {
  if (violation.sectionKey !== null) {
    return sections.some((section) => section.key === violation.sectionKey)
      ? { kind: 'section', key: violation.sectionKey }
      : { kind: 'none' };
  }
  const panel = violation.field === null ? undefined : PANEL_OF_FIELD[violation.field];
  return panel === undefined || violation.field === null
    ? { kind: 'none' }
    : { kind: 'panel', panel, field: violation.field };
}

export interface CompletionSummary {
  readonly blocking: readonly Violation[];
  readonly warnings: readonly Violation[];
}

export function completionSummaryOf(violations: readonly Violation[]): CompletionSummary {
  return {
    blocking: violations.filter((item) => item.severity === 'BLOCKING'),
    warnings: violations.filter((item) => item.severity === 'WARNING'),
  };
}
