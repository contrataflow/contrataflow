import { PROCESS_COMPLETION_LIMITS, PROCESS_COMPLETION_MESSAGES } from '@contrataflow/validation';
import type { ActionEntry, ChecklistViolation } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { mergeRules, rulesFor, rulesOfViolations } from '../process-forward/forward-model';
import type { ForwardRule } from '../process-forward/forward-model';

/*
 * Regras puras do diálogo "Concluir processo" (US-010 · SCR-116): a ação `COMPLETE` do PRC-08 (a
 * transição `COMPLETE` ou, na etapa `END` já ativa, a entrada sem transição — FA-03), as pendências
 * do PRC-09 que valem para ela (o mesmo painel de checklist do encaminhamento — DEC-180), a
 * observação com as mesmas regras do PRC-26 e os erros da API como o comportamento da tabela
 * "Casos de erro" da story.
 */

/** A entrada `COMPLETE` do PRC-08 (a principal primeiro); `undefined` = sem conclusão disponível. */
export function completionEntry(
  actions: readonly ActionEntry[] | undefined,
): ActionEntry | undefined {
  const entries = (actions ?? []).filter((entry) => entry.action === 'COMPLETE');
  return entries.find((entry) => entry.primary === true) ?? entries[0];
}

/**
 * RN-PROC-113: pendências e avisos que valem para a conclusão — `STAGE_EXIT` da etapa e
 * `TRANSITION` da transição `COMPLETE` (na etapa `END`, só as de saída) —, somadas às que a API
 * apontou depois da carga.
 */
export function completionRules(
  checklist: readonly ChecklistViolation[] | undefined,
  entry: ActionEntry | undefined,
  fromServer: readonly ForwardRule[] = [],
): ForwardRule[] {
  return mergeRules(rulesFor(checklist, entry), fromServer);
}

/** V-05: avisos ainda não reconhecidos (o botão fica desabilitado até todos serem marcados). */
export function pendingWarnings(
  rules: readonly ForwardRule[],
  acknowledged: readonly string[],
): ForwardRule[] {
  return rules.filter((rule) => rule.severity === 'WARNING' && !acknowledged.includes(rule.ruleId));
}

/** Observação opcional até 5.000 caracteres (sem espaços nas pontas). */
export function validateCompletionComment(comment: string): string | undefined {
  return comment.trim().length > PROCESS_COMPLETION_LIMITS.commentMax
    ? PROCESS_COMPLETION_MESSAGES.commentTooLong
    : undefined;
}

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-010). */
export type CompletionProblem =
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'blocked'; readonly rules: readonly ForwardRule[] }
  | { readonly kind: 'warnings'; readonly rules: readonly ForwardRule[] }
  | { readonly kind: 'transition' }
  | { readonly kind: 'status' }
  | { readonly kind: 'notCustodian' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'access' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'reused' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeCompletionError(error: unknown): CompletionProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 412 || status === 428) return { kind: 'stale' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 403 && code === 'NOT_PROCESS_CUSTODIAN') return { kind: 'notCustodian' };
  if (status === 403 && (code === 'TENANT_SUSPENDED' || code === 'MEMBERSHIP_INACTIVE')) {
    return { kind: 'access' };
  }
  if (status === 403) return { kind: 'permission' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 422) {
    if (code === 'TRANSITION_BLOCKED') {
      return { kind: 'blocked', rules: rulesOfViolations(error.violations) };
    }
    if (code === 'WARNINGS_NOT_ACKNOWLEDGED') {
      return { kind: 'warnings', rules: rulesOfViolations(error.violations) };
    }
    if (code === 'TRANSITION_NOT_AVAILABLE') return { kind: 'transition' };
    if (code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'reused' };
    if (code === 'VALIDATION_ERROR') {
      const message = error.errors.find((item) => item.field === 'comment')?.message;
      return { kind: 'field', message: message ?? PROCESS_COMPLETION_MESSAGES.commentTooLong };
    }
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
