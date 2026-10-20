import { PROCESS_RETURN_LIMITS, PROCESS_RETURN_MESSAGES } from '@contrataflow/validation';
import type { ActionEntry, ReturnProcessInput } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { addDays } from '../process-forward/forward-model';

/*
 * Regras puras do diálogo "Devolver processo" (US-048 · SCR-104): os destinos vêm das entradas
 * `RETURN` de PRC-08 (etapa já percorrida, com a data da última passagem); o motivo segue as mesmas
 * regras do PRC-20 (`returnProcessSchema`); o prazo só aparece quando a transição permite; os erros
 * da API viram o comportamento da tabela "Casos de erro" da story.
 */

/** Destino da devolução como o diálogo o mostra. */
export interface ReturnTarget {
  /** `WorkflowStage` (o `targetStageId` do PRC-20). */
  readonly stageId: string;
  readonly stageName: string;
  /** Saída da última passagem pela etapa (ISO). */
  readonly lastPassedAt: string | null;
  readonly allowDueDateOverride: boolean;
}

/** Campos do diálogo, na ordem da tela (foco no primeiro erro). */
export const RETURN_FIELD_ORDER = ['targetStageId', 'comment', 'dueAt'] as const;
export type ReturnField = (typeof RETURN_FIELD_ORDER)[number];
export type ReturnFieldMessages = Partial<Record<ReturnField, string>>;

/** Prazo máximo informado na devolução: hoje + 365 dias (RN-TRAM-26). */
const DUE_MAX_DAYS = 365;

/** RN-TRAM-24: destinos habilitados de PRC-08, um por etapa, na ordem da API. */
export function returnTargets(actions: readonly ActionEntry[] | undefined): ReturnTarget[] {
  const targets: ReturnTarget[] = [];
  for (const entry of actions ?? []) {
    if (entry.action !== 'RETURN' || !entry.enabled || entry.toStageId === undefined) continue;
    if (targets.some((target) => target.stageId === entry.toStageId)) continue;
    targets.push({
      stageId: entry.toStageId,
      stageName: entry.toStageName ?? entry.label,
      lastPassedAt: entry.lastPassedAt ?? null,
      allowDueDateOverride: entry.allowDueDateOverride === true,
    });
  }
  return targets;
}

/** Destino inicial: o da ação escolhida no menu ou, havendo um só, ele (FA-03). */
export function initialTargetId(
  targets: readonly ReturnTarget[],
  preferredStageId: string | null | undefined,
): string | null {
  if (preferredStageId && targets.some((target) => target.stageId === preferredStageId)) {
    return preferredStageId;
  }
  return targets.length === 1 ? (targets[0]?.stageId ?? null) : null;
}

export interface ReturnDraft {
  readonly target: ReturnTarget | undefined;
  readonly comment: string;
  /** `AAAA-MM-DD`; vazio = prazo da SLA (só existe quando a transição permite). */
  readonly dueAt: string;
}

/** V-01/V-02 e o intervalo do prazo informado (o mesmo do PRC-20). */
export function validateReturn(draft: ReturnDraft, today: string): ReturnFieldMessages {
  const messages: ReturnFieldMessages = {};
  if (draft.target === undefined) messages.targetStageId = PROCESS_RETURN_MESSAGES.targetRequired;
  const comment = draft.comment.trim();
  if (comment.length === 0) messages.comment = PROCESS_RETURN_MESSAGES.commentRequired;
  else if (comment.length < PROCESS_RETURN_LIMITS.commentMin) {
    messages.comment = PROCESS_RETURN_MESSAGES.commentTooShort;
  } else if (comment.length > PROCESS_RETURN_LIMITS.commentMax) {
    messages.comment = PROCESS_RETURN_MESSAGES.commentTooLong;
  }
  if (draft.target?.allowDueDateOverride === true && draft.dueAt !== '') {
    if (draft.dueAt < today || draft.dueAt > addDays(today, DUE_MAX_DAYS)) {
      messages.dueAt = PROCESS_RETURN_MESSAGES.dueDateRange;
    }
  }
  return messages;
}

/** Corpo do PRC-20: `dueAt` só quando a transição permite e o usuário informou. */
export function buildReturnBody(
  draft: ReturnDraft & { readonly target: ReturnTarget },
  expectedStageId: string,
): ReturnProcessInput {
  return {
    targetStageId: draft.target.stageId,
    comment: draft.comment.trim(),
    expectedStageId,
    ...(draft.target.allowDueDateOverride && draft.dueAt !== '' ? { dueAt: draft.dueAt } : {}),
  };
}

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-048). */
export type ReturnProblem =
  | { readonly kind: 'fields'; readonly messages: ReturnFieldMessages; readonly others: string[] }
  | { readonly kind: 'targetNotAvailable' }
  | { readonly kind: 'dueNotAllowed' }
  | { readonly kind: 'status' }
  | { readonly kind: 'custody' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'stale'; readonly code: 'STAGE_CHANGED' | 'VERSION_CONFLICT' }
  | { readonly kind: 'precondition' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

const isReturnField = (field: string): field is ReturnField =>
  (RETURN_FIELD_ORDER as readonly string[]).includes(field);

export function describeReturnError(error: unknown): ReturnProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 409 && code === 'STAGE_CHANGED') return { kind: 'stale', code };
  if (status === 412 && code === 'VERSION_CONFLICT') return { kind: 'stale', code };
  if (status === 428) return { kind: 'precondition' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 403) return { kind: 'custody' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 422 && code === 'TRANSITION_NOT_AVAILABLE') return { kind: 'targetNotAvailable' };
  if (status === 422 && code === 'DUE_DATE_OVERRIDE_NOT_ALLOWED') return { kind: 'dueNotAllowed' };
  if (status === 422 && code === 'VALIDATION_ERROR') {
    const messages: ReturnFieldMessages = {};
    const others: string[] = [];
    for (const item of error.errors) {
      if (isReturnField(item.field)) messages[item.field] ??= item.message;
      else others.push(item.message);
    }
    return { kind: 'fields', messages, others };
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
