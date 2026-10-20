import {
  PROCESS_ASSIGN_LIMITS,
  PROCESS_ASSIGN_MESSAGES,
  assignReasonRequired,
} from '@contrataflow/validation';
import type { AssignProcessInput, UserLookupItem } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do diálogo "Atribuir responsável" (US-050 · SCR-115): a escolha (pessoa ou "Deixar
 * na fila da unidade"), o motivo condicional (RN-TRAM-39, a mesma regra do PRC-22), o corpo enviado
 * e o comportamento de cada recusa da tabela "Casos de erro" da story.
 */

/** Valor do seletor para "Deixar na fila da unidade" (`assigneeId = null` — RN-TRAM-40). */
export const QUEUE_OPTION = 'queue';

/** `''` = nada escolhido; `QUEUE_OPTION` = fila; senão o `userId`. */
export type AssignSelection = string;

export interface AssignDraft {
  readonly selection: AssignSelection;
  readonly reason: string;
}

export interface AssignFormErrors {
  readonly assignee?: string;
  readonly reason?: string;
}

/** Membros oferecidos: os lotados na unidade atual, menos o responsável atual (não há "troca"). */
export function memberOptions(
  members: readonly UserLookupItem[],
  currentResponsibleId: string | null,
): UserLookupItem[] {
  return members.filter((member) => member.id !== currentResponsibleId);
}

/** "Deixar na fila" só faz sentido quando há um responsável a remover (FA-02). */
export function canQueue(currentResponsibleId: string | null): boolean {
  return currentResponsibleId !== null;
}

/** V-01..V-03 no cliente (as mesmas mensagens da API). Vazio = pode enviar. */
export function validateAssign(
  draft: AssignDraft,
  currentResponsibleId: string | null,
): AssignFormErrors {
  const errors: { assignee?: string; reason?: string } = {};
  if (draft.selection === '') errors.assignee = PROCESS_ASSIGN_MESSAGES.assigneeRequired;
  const length = draft.reason.trim().length;
  if (length === 0) {
    if (assignReasonRequired(currentResponsibleId)) {
      errors.reason = PROCESS_ASSIGN_MESSAGES.reasonRequired;
    }
  } else if (length < PROCESS_ASSIGN_LIMITS.reasonMin) {
    errors.reason = PROCESS_ASSIGN_MESSAGES.reasonTooShort;
  } else if (length > PROCESS_ASSIGN_LIMITS.reasonMax) {
    errors.reason = PROCESS_ASSIGN_MESSAGES.reasonTooLong;
  }
  return errors;
}

/** Corpo do PRC-22: `assigneeId` sempre presente; `reason` só quando escrito. */
export function assignBodyOf(draft: AssignDraft): AssignProcessInput {
  const reason = draft.reason.trim();
  return {
    assigneeId: draft.selection === QUEUE_OPTION ? null : draft.selection,
    ...(reason === '' ? {} : { reason }),
  };
}

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-050). */
export type AssignProblem =
  | { readonly kind: 'field'; readonly field: 'assignee' | 'reason'; readonly message: string }
  /** 422 `ASSIGNEE_NOT_ELIGIBLE`: remove a opção e recarrega a lista. */
  | { readonly kind: 'notEligible' }
  /** 422 `REFERENCE_NOT_FOUND`: recarrega a lista de membros. */
  | { readonly kind: 'reference' }
  | { readonly kind: 'status' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeAssignError(error: unknown): AssignProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 412 || status === 428) return { kind: 'stale' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 403) return { kind: 'permission' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 422 && code === 'ASSIGNEE_NOT_ELIGIBLE') return { kind: 'notEligible' };
  if (status === 422 && code === 'VALIDATION_ERROR') {
    const assignee = error.errors.find((item) => item.field === 'assigneeId');
    if (assignee?.code === 'REFERENCE_NOT_FOUND') return { kind: 'reference' };
    if (assignee !== undefined) {
      return { kind: 'field', field: 'assignee', message: assignee.message };
    }
    const reason = error.errors.find((item) => item.field === 'reason');
    return {
      kind: 'field',
      field: 'reason',
      message: reason?.message ?? PROCESS_ASSIGN_MESSAGES.reasonRequired,
    };
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
