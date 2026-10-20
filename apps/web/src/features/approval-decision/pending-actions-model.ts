import {
  APPROVAL_WITHDRAWAL_LIMITS,
  APPROVAL_WITHDRAWAL_MESSAGES,
  reassignIssues,
} from '@contrataflow/validation';
import type {
  ApprovalMeta,
  ReassignApprovalInput,
  WithdrawApprovalInput,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras das ações sobre a aprovação pendente (US-053 · SCR-015): retirar (APV-04 — motivo
 * opcional, até 2.000) e redirecionar (APV-05 — novo aprovador do tipo escolhido e motivo de 10 a
 * 2.000, as MESMAS regras do contrato — V-01). As ações aparecem só com `WITHDRAW`/`REASSIGN` em
 * `meta.allowedActions`; os erros da API viram o comportamento da tabela "Casos de erro".
 */

/** `meta.allowedActions` contém `WITHDRAW` (POL-17). */
export function canWithdraw(meta: ApprovalMeta): boolean {
  return meta.allowedActions.includes('WITHDRAW');
}

/** `meta.allowedActions` contém `REASSIGN` (`APPROVAL_REASSIGN` cobrindo o processo). */
export function canReassign(meta: ApprovalMeta): boolean {
  return meta.allowedActions.includes('REASSIGN');
}

/** Tipos de novo aprovador oferecidos na tela (pessoa ou titular de outra unidade — FA-02). */
export const REASSIGN_TARGET_TYPES = ['USER', 'DEPARTMENT_HEAD'] as const;
export type ReassignTargetType = (typeof REASSIGN_TARGET_TYPES)[number];

export interface ReassignDraft {
  readonly approverType: ReassignTargetType;
  /** Usuário (`USER`) ou unidade (`DEPARTMENT_HEAD`) escolhido; `null` = nada escolhido. */
  readonly targetId: string | null;
  readonly reason: string;
}

export type ReassignField = 'target' | 'reason';
export type ReassignFieldMessages = Partial<Record<ReassignField, string>>;

/** O corpo do APV-05: exatamente o `targetApprover*` do tipo e o motivo sem os espaços das pontas. */
export function reassignBodyOf(draft: ReassignDraft): ReassignApprovalInput {
  const target = draft.targetId ?? undefined;
  return draft.approverType === 'USER'
    ? { approverType: 'USER', targetApproverUserId: target, reason: draft.reason.trim() }
    : {
        approverType: 'DEPARTMENT_HEAD',
        targetApproverDepartmentId: target,
        reason: draft.reason.trim(),
      };
}

/** V-01 no front (as mesmas regras do contrato): o alvo e o motivo, por campo da tela. */
export function validateReassign(draft: ReassignDraft): ReassignFieldMessages {
  const messages: ReassignFieldMessages = {};
  for (const issue of reassignIssues(reassignBodyOf(draft))) {
    const field: ReassignField = issue.field === 'reason' ? 'reason' : 'target';
    messages[field] ??= issue.message;
  }
  if (draft.reason.trim().length > APPROVAL_WITHDRAWAL_LIMITS.reasonMax) {
    messages.reason ??= APPROVAL_WITHDRAWAL_MESSAGES.reasonTooLong;
  }
  return messages;
}

/** O corpo do APV-04/DOC-11: motivo só quando informado. */
export function withdrawBodyOf(reason: string): WithdrawApprovalInput {
  const text = reason.trim();
  return text === '' ? {} : { reason: text };
}

export type PendingActionProblem =
  | { readonly kind: 'notPending' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'precondition' }
  | { readonly kind: 'processStatus' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'selfApproval' }
  | { readonly kind: 'notEligible' }
  | { readonly kind: 'idempotencyReused' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'fields'; readonly messages: ReassignFieldMessages }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** Tabela "Casos de erro" da US-053. */
export function describePendingActionError(error: unknown): PendingActionProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 428) return { kind: 'precondition' };
  if (status === 412) return { kind: 'stale' };
  if (status === 409 && code === 'APPROVAL_NOT_PENDING') return { kind: 'notPending' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'processStatus' };
  if (status === 403) {
    return code === 'SELF_APPROVAL_FORBIDDEN' ? { kind: 'selfApproval' } : { kind: 'denied' };
  }
  if (status === 404) return { kind: 'notFound' };
  if (status === 422) {
    if (code === 'APPROVER_NOT_ELIGIBLE') return { kind: 'notEligible' };
    if (code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'idempotencyReused' };
    if (code === 'VALIDATION_ERROR') {
      const messages: ReassignFieldMessages = {};
      for (const item of error.errors) {
        const field: ReassignField = item.field === 'reason' ? 'reason' : 'target';
        messages[field] ??= item.message;
      }
      return { kind: 'fields', messages };
    }
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

/**
 * Recusas que encerram o diálogo e a tela inteira explica (recarregando a aprovação): já decidida
 * ou retirada, atualizada por outra pessoa, processo fora de andamento, sem permissão ou sumiu.
 */
export function isClosingProblem(problem: PendingActionProblem): boolean {
  switch (problem.kind) {
    case 'notPending':
    case 'stale':
    case 'precondition':
    case 'processStatus':
    case 'notFound':
    case 'denied':
      return true;
    default:
      return false;
  }
}
