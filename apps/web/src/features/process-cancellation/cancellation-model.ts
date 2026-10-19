import {
  PROCESS_CANCELLATION_LIMITS,
  PROCESS_CANCELLATION_MESSAGES,
} from '@contrataflow/validation';
import type { ProcessSummaryDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras dos diálogos "Cancelar processo" e "Descartar rascunho" (US-009 · SCR-116): a
 * justificativa e o motivo seguem as mesmas regras do PRC-25/PRC-06; a lista de impactos vem do
 * painel (aprovações pendentes e documentos em aprovação); os erros da API viram o comportamento
 * da tabela "Casos de erro" da story.
 */

/** V-01 · FA-04: justificativa com pelo menos 20 caracteres (sem espaços nas pontas). */
export function validateCancellationReason(reason: string): string | undefined {
  const length = reason.trim().length;
  if (length < PROCESS_CANCELLATION_LIMITS.reasonMin) {
    return PROCESS_CANCELLATION_MESSAGES.reasonTooShort;
  }
  if (length > PROCESS_CANCELLATION_LIMITS.reasonMax) {
    return PROCESS_CANCELLATION_MESSAGES.reasonTooLong;
  }
  return undefined;
}

/** Motivo opcional do descarte, até 500 caracteres. */
export function validateDiscardReason(reason: string): string | undefined {
  return reason.trim().length > PROCESS_CANCELLATION_LIMITS.discardReasonMax
    ? PROCESS_CANCELLATION_MESSAGES.discardReasonTooLong
    : undefined;
}

/** O que o cancelamento encerra (FA-02): aprovações pendentes e documentos que voltam a rascunho. */
export interface CancellationImpact {
  readonly pendingApprovals: number;
  readonly documentsInApproval: number;
}

export function cancellationImpact(summary: ProcessSummaryDto | undefined): CancellationImpact {
  return {
    pendingApprovals: summary?.approvals.length ?? 0,
    documentsInApproval: summary?.documents.filter((document) => document.inApproval).length ?? 0,
  };
}

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-009). */
export type CancellationProblem =
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'numbered' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'access' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeCancellationError(
  error: unknown,
  field: 'cancellationReason' | 'reason',
): CancellationProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 412 || status === 428) return { kind: 'stale' };
  if (status === 409 && code === 'CANNOT_DISCARD_NUMBERED_PROCESS') return { kind: 'numbered' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 403 && (code === 'TENANT_SUSPENDED' || code === 'MEMBERSHIP_INACTIVE')) {
    return { kind: 'access' };
  }
  if (status === 403) return { kind: 'permission' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 422 && code === 'VALIDATION_ERROR') {
    const message = error.errors.find((item) => item.field === field)?.message;
    return {
      kind: 'field',
      message:
        message ??
        (field === 'cancellationReason'
          ? PROCESS_CANCELLATION_MESSAGES.reasonTooShort
          : PROCESS_CANCELLATION_MESSAGES.discardReasonTooLong),
    };
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
