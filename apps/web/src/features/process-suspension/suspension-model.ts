import { addCalendarDays, daysInInterval } from '@contrataflow/types';
import type { DayCountType } from '@contrataflow/types';
import { PROCESS_SUSPENSION_LIMITS, PROCESS_SUSPENSION_MESSAGES } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { localToday } from '../process-forward/forward-model';

/*
 * Regras puras dos diálogos "Suspender processo" e "Retomar processo" (US-008 · SCR-116): o motivo
 * e o comentário seguem as mesmas regras do PRC-23/PRC-24; a prévia da retomada usa o mesmo
 * intervalo da API (RN-PROC-98: [data local da pausa, data local de hoje)); os erros da API viram o
 * comportamento da tabela "Casos de erro" da story.
 */

/** V-01: motivo de 20 a 5.000 caracteres (sem espaços nas pontas). */
export function validateSuspendReason(reason: string): string | undefined {
  const length = reason.trim().length;
  if (length < PROCESS_SUSPENSION_LIMITS.reasonMin)
    return PROCESS_SUSPENSION_MESSAGES.reasonRequired;
  if (length > PROCESS_SUSPENSION_LIMITS.reasonMax)
    return PROCESS_SUSPENSION_MESSAGES.reasonTooLong;
  return undefined;
}

/** RN-PROC-97: comentário opcional, até 5.000 caracteres. */
export function validateResumeComment(comment: string): string | undefined {
  return comment.trim().length > PROCESS_SUSPENSION_LIMITS.commentMax
    ? PROCESS_SUSPENSION_MESSAGES.commentTooLong
    : undefined;
}

/** Período suspenso em datas locais do tenant: da pausa (conta) a hoje (não conta). */
export interface SuspendedPeriod {
  readonly from: string;
  readonly to: string;
}

export function suspendedPeriod(suspendedAt: string, now: Date, timeZone: string): SuspendedPeriod {
  return { from: localToday(new Date(suspendedAt), timeZone), to: localToday(now, timeZone) };
}

/**
 * O que consultar para os dias acrescidos: `none` (mesmo dia — FA-04), `calendar` (dias corridos,
 * sem feriados) ou `business` (CAL-05 de `from` até a véspera de `to`, inclusive).
 */
export type ExtensionQuery =
  | { readonly kind: 'none' }
  | { readonly kind: 'calendar'; readonly days: number }
  | { readonly kind: 'business'; readonly from: string; readonly to: string };

export function extensionQuery(period: SuspendedPeriod, slaType: DayCountType): ExtensionQuery {
  if (period.from >= period.to) return { kind: 'none' };
  if (slaType === 'CALENDAR') {
    return {
      kind: 'calendar',
      days: daysInInterval(period.from, period.to, 'CALENDAR', new Set()),
    };
  }
  return { kind: 'business', from: period.from, to: addCalendarDays(period.to, -1) };
}

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-008). */
export type SuspensionProblem =
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'permission' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'access' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'keyReused' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function describeSuspensionError(
  error: unknown,
  field: 'reason' | 'comment',
): SuspensionProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 412 || status === 428) return { kind: 'stale' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'status' };
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') return { kind: 'inProgress' };
  if (status === 422 && code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'keyReused' };
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
        (field === 'reason'
          ? PROCESS_SUSPENSION_MESSAGES.reasonRequired
          : PROCESS_SUSPENSION_MESSAGES.commentTooLong),
    };
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
