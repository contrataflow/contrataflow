import { etpStructuredKind } from '@contrataflow/validation';
import type { EtpTemplateSectionDto, Violation } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras de tela da conclusão do ETP (US-023 · SCR-008), puras e testadas: para onde cada pendência
 * do DOC-08 leva (a seção, o quadro de itens/alternativas ou os campos de conclusão), o resumo de
 * bloqueantes × avisos e o desfecho de uma falha do ETP-04.
 */

/** Destino do link de uma pendência no resumo "Pendências para concluir". */
export type PendingTarget =
  | { readonly kind: 'section'; readonly key: string }
  | { readonly kind: 'conclusion'; readonly field: 'conclusion' | 'parcelingDecision' }
  | { readonly kind: 'none' };

const sectionOfKind = (
  sections: readonly EtpTemplateSectionDto[],
  kind: 'ITEMS' | 'ALTERNATIVES',
): PendingTarget => {
  const found = sections.find((section) => etpStructuredKind(section) === kind);
  return found === undefined ? { kind: 'none' } : { kind: 'section', key: found.key };
};

export function pendingTargetOf(
  violation: Pick<Violation, 'code' | 'field' | 'sectionKey'>,
  sections: readonly EtpTemplateSectionDto[],
): PendingTarget {
  if (violation.sectionKey !== null) {
    return sections.some((section) => section.key === violation.sectionKey)
      ? { kind: 'section', key: violation.sectionKey }
      : { kind: 'none' };
  }
  if (violation.field === 'conclusion' || violation.field === 'parcelingDecision') {
    return { kind: 'conclusion', field: violation.field };
  }
  switch (violation.code) {
    case 'ITEMS_REQUIRED':
    case 'ETP_ESTIMATED_VALUE_REQUIRED':
      return sectionOfKind(sections, 'ITEMS');
    case 'ETP_RECOMMENDED_ALTERNATIVE_REQUIRED':
      return sectionOfKind(sections, 'ALTERNATIVES');
    default:
      return { kind: 'none' };
  }
}

export interface PendingSummary {
  readonly blocking: readonly Violation[];
  readonly warnings: readonly Violation[];
}

export function pendingSummaryOf(violations: readonly Violation[]): PendingSummary {
  return {
    blocking: violations.filter((item) => item.severity === 'BLOCKING'),
    warnings: violations.filter((item) => item.severity === 'WARNING'),
  };
}

/** Falha do ETP-04 na conclusão/parcelamento: a chave da mensagem (ou o `correlationId`). */
export type ConclusionProblem =
  | {
      readonly kind: 'message';
      readonly key: 'conflict' | 'forbidden' | 'notEditable' | 'unavailable' | 'invalid';
    }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function conclusionProblemOf(error: unknown): ConclusionProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  if (error.status === 412 || error.status === 428) return { kind: 'message', key: 'conflict' };
  if (error.status === 403) return { kind: 'message', key: 'forbidden' };
  if (error.status === 409) return { kind: 'message', key: 'notEditable' };
  if (error.status === 503 || error.status === 429) return { kind: 'message', key: 'unavailable' };
  if (error.status === 422) return { kind: 'message', key: 'invalid' };
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
