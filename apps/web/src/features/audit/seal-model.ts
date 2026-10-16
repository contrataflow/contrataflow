import { AUDIT_SEAL_MESSAGES, verifyAuditSealsSchema } from '@contrataflow/validation';
import type {
  AuditSealDto,
  AuditSealVerification,
  AuditSealVerificationItem,
  VerifyAuditSeals,
} from '@contrataflow/validation';

import { zoneOffsetMs } from '@/features/timeline/timeline-model';
import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras da aba "Selos" (US-074 · SCR-037): status por selo combinado com o último
 * resultado de verificação, conversão do intervalo (campos `datetime-local` no fuso da instituição
 * ↔ ISO UTC), validação com o MESMO schema da API (V-02) e classificação dos erros de AUD-05.
 */

/** Status mostrado na lista: "Não verificado" até uma verificação cobrir o selo. */
export type SealStatus = 'unverified' | 'valid' | 'broken';

/** Resultados da última verificação, indexados pelo início do período (ms UTC). */
export type VerificationIndex = ReadonlyMap<number, AuditSealVerificationItem>;

export function verificationIndex(verification: AuditSealVerification | null): VerificationIndex {
  return new Map(
    (verification?.results ?? []).map((item) => [Date.parse(item.periodStart), item] as const),
  );
}

/** Status do selo: o resultado da verificação, se o selo foi coberto por ela. */
export function sealStatusOf(
  seal: Pick<AuditSealDto, 'periodStart'>,
  index: VerificationIndex,
): SealStatus {
  const check = index.get(Date.parse(seal.periodStart));
  if (check === undefined) return 'unverified';
  return check.status === 'VALID' ? 'valid' : 'broken';
}

/** Menor `periodStart` e maior `periodEnd` dos selos (ISO), ou `null` sem selos. */
export function rangeOfSeals(
  seals: Iterable<Pick<AuditSealDto, 'periodStart' | 'periodEnd'>>,
): { readonly start: string; readonly end: string } | null {
  let start: string | null = null;
  let end: string | null = null;
  for (const seal of seals) {
    if (start === null || Date.parse(seal.periodStart) < Date.parse(start))
      start = seal.periodStart;
    if (end === null || Date.parse(seal.periodEnd) > Date.parse(end)) end = seal.periodEnd;
  }
  return start === null || end === null ? null : { start, end };
}

/** Valor de `<input type="datetime-local">` (`AAAA-MM-DDTHH:mm`) do instante no fuso. */
export function isoToLocalInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

/** ISO UTC do relógio de parede `AAAA-MM-DDTHH:mm` no fuso IANA; `null` se inválido. */
export function localInputToIso(local: string, timeZone: string): string | null {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
  const guess = Date.parse(`${normalized}Z`);
  if (Number.isNaN(guess)) return null;
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  const second = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface RangeInput {
  readonly start: string;
  readonly end: string;
}

export const EMPTY_RANGE: RangeInput = { start: '', end: '' };

export interface RangeErrors {
  readonly start?: string;
  readonly end?: string;
}

export type RangeValidation =
  | { readonly ok: true; readonly body: VerifyAuditSeals }
  | { readonly ok: false; readonly errors: RangeErrors };

/**
 * Valida o intervalo digitado: campos obrigatórios e `verifyAuditSealsSchema` (V-02 — o mesmo da
 * API). O teto de selos (V-01) é conferido só pela API.
 */
export function validateRange(
  input: RangeInput,
  timeZone: string,
  messages: { readonly required: string },
): RangeValidation {
  const start = input.start === '' ? null : localInputToIso(input.start, timeZone);
  const end = input.end === '' ? null : localInputToIso(input.end, timeZone);
  if (start === null || end === null) {
    return {
      ok: false,
      errors: {
        ...(start === null ? { start: messages.required } : {}),
        ...(end === null ? { end: messages.required } : {}),
      },
    };
  }
  const parsed = verifyAuditSealsSchema.safeParse({ periodStart: start, periodEnd: end });
  if (parsed.success) return { ok: true, body: parsed.data };
  const message = parsed.error.issues[0]?.message ?? AUDIT_SEAL_MESSAGES.periodRange;
  return { ok: false, errors: { end: message } };
}

/** Como a aba reage a cada falha de AUD-05 (Casos de erro da US-074). */
export type VerifyFailure =
  | { readonly kind: 'validation'; readonly message: string }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable'; readonly correlationId: string | null }
  | { readonly kind: 'mfa' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

export function classifyVerifyError(error: unknown): VerifyFailure {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  if (error.status === 403 && error.code === 'MFA_REQUIRED') return { kind: 'mfa' };
  if (error.status === 403) return { kind: 'forbidden' };
  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 422) {
    const message = error.errors.find((item) => item.message !== '')?.message;
    return { kind: 'validation', message: message ?? AUDIT_SEAL_MESSAGES.periodRange };
  }
  if (error.status === 503) return { kind: 'unavailable', correlationId: error.correlationId };
  return { kind: 'unexpected', correlationId: error.correlationId };
}
