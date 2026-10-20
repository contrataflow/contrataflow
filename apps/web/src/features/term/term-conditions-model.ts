import {
  TERM_CONDITION_LIMITS,
  TERM_CONDITION_MESSAGES,
  termDeadlineIssue,
} from '@contrataflow/validation';
import type { AwardType, TermConditionField, TermDto, TermPatch } from '@contrataflow/validation';

/*
 * Regras puras do painel "Condições contratuais" do TR (US-038 · SCR-012 · RN-TR-28..32): o
 * formulário (números como texto, percentual no formato brasileiro), a validação V-05..V-08 com os
 * MESMOS limites e mensagens da API (`TERM_CONDITION_LIMITS`/`TERM_CONDITION_MESSAGES` e
 * `termDeadlineIssue` — o prazo e o tipo de contagem, um exige o outro) e o corpo do TRM-04 só com
 * os campos alterados (vazio = `null`, limpa).
 */

export type DayCount = 'BUSINESS' | 'CALENDAR';

export interface TermConditionsForm {
  readonly contractDurationMonths: string;
  readonly executionDeadline: string;
  readonly executionDeadlineType: DayCount | '';
  readonly deliveryLocation: string;
  readonly paymentTermDays: string;
  readonly productWarrantyMonths: string;
  /** Percentual digitado ("5" ou "2,5"). */
  readonly contractGuaranteePercent: string;
  readonly allowsSubcontracting: boolean;
  readonly selectionCriterionId: string;
  readonly awardType: AwardType | '';
}

export type TermConditionsErrors = Partial<Record<TermConditionField, string>>;

const numberText = (value: number | null) => (value === null ? '' : String(value));

/** `"5.5000"` → `"5,5"`; `"10"` → `"10"`. */
function percentText(value: string | null): string {
  if (value === null) return '';
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole : `${whole},${trimmed}`;
}

/** O formulário a partir do TR gravado. */
export function conditionsFormOf(term: TermDto): TermConditionsForm {
  return {
    contractDurationMonths: numberText(term.contractDurationMonths),
    executionDeadline: numberText(term.executionDeadline),
    executionDeadlineType: term.executionDeadlineType ?? '',
    deliveryLocation: term.deliveryLocation ?? '',
    paymentTermDays: numberText(term.paymentTermDays),
    productWarrantyMonths: numberText(term.productWarrantyMonths),
    contractGuaranteePercent: percentText(term.contractGuaranteePercent),
    allowsSubcontracting: term.allowsSubcontracting ?? false,
    selectionCriterionId: term.selectionCriterionId ?? '',
    awardType: term.awardType ?? '',
  };
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Inteiro na faixa (vazio = `null`). */
function intIn(text: string, min: number, max: number): Parsed<number | null> {
  const clean = text.trim();
  if (clean === '') return { ok: true, value: null };
  if (!/^-?\d+$/.test(clean)) return { ok: false };
  const value = Number(clean);
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

/** Percentual 0–10 com até 4 casas (vazio = `null`) como string decimal com ponto. */
function percentIn(text: string): Parsed<string | null> {
  const clean = text.trim().replace(',', '.');
  if (clean === '') return { ok: true, value: null };
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(clean)) return { ok: false };
  if (Number(clean) > TERM_CONDITION_LIMITS.contractGuaranteeMax) return { ok: false };
  // Forma canônica ("05,50" → "5.5"): a mesma do TR gravado, para comparar a mudança.
  return { ok: true, value: percentText(clean.replace(/^0+(?=\d)/, '')).replace(',', '.') };
}

export type ConditionsCheck =
  | { readonly ok: true; readonly body: TermPatch }
  | { readonly ok: false; readonly errors: TermConditionsErrors };

/**
 * V-05..V-08 e o corpo do TRM-04 com os campos alterados em relação ao TR gravado. Corpo vazio =
 * nada a salvar.
 */
export function conditionsBody(form: TermConditionsForm, term: TermDto): ConditionsCheck {
  const errors: TermConditionsErrors = {};
  const limits = TERM_CONDITION_LIMITS;
  const duration = intIn(
    form.contractDurationMonths,
    limits.contractDurationMin,
    limits.contractDurationMax,
  );
  if (!duration.ok) errors.contractDurationMonths = TERM_CONDITION_MESSAGES.durationRange;
  const deadline = intIn(
    form.executionDeadline,
    limits.executionDeadlineMin,
    limits.executionDeadlineMax,
  );
  if (!deadline.ok) errors.executionDeadline = TERM_CONDITION_MESSAGES.deadlineRange;
  const payment = intIn(form.paymentTermDays, limits.paymentTermMin, limits.paymentTermMax);
  if (!payment.ok) errors.paymentTermDays = TERM_CONDITION_MESSAGES.paymentRange;
  const warranty = intIn(
    form.productWarrantyMonths,
    limits.productWarrantyMin,
    limits.productWarrantyMax,
  );
  if (!warranty.ok) errors.productWarrantyMonths = TERM_CONDITION_MESSAGES.warrantyRange;
  const percent = percentIn(form.contractGuaranteePercent);
  if (!percent.ok) errors.contractGuaranteePercent = TERM_CONDITION_MESSAGES.guaranteeRange;
  const location = form.deliveryLocation.trim();
  if (Array.from(location).length > limits.deliveryLocationMax) {
    errors.deliveryLocation = TERM_CONDITION_MESSAGES.deliveryLocationLength;
  }
  if (deadline.ok) {
    const issue = termDeadlineIssue(
      deadline.value,
      form.executionDeadlineType === '' ? null : form.executionDeadlineType,
    );
    if (issue !== null) errors[issue.field as TermConditionField] = issue.message;
  }
  if (
    !duration.ok ||
    !deadline.ok ||
    !payment.ok ||
    !warranty.ok ||
    !percent.ok ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }

  const next: Pick<TermPatch, TermConditionField> = {
    contractDurationMonths: duration.value,
    executionDeadline: deadline.value,
    executionDeadlineType: form.executionDeadlineType === '' ? null : form.executionDeadlineType,
    deliveryLocation: location === '' ? null : location,
    paymentTermDays: payment.value,
    productWarrantyMonths: warranty.value,
    contractGuaranteePercent: percent.value,
    allowsSubcontracting: form.allowsSubcontracting,
    selectionCriterionId: form.selectionCriterionId === '' ? null : form.selectionCriterionId,
    awardType: form.awardType === '' ? null : form.awardType,
  };
  const saved = conditionsBodyBaseline(term);
  const body: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(next)) {
    if (value !== saved[field as TermConditionField]) body[field] = value;
  }
  return { ok: true, body };
}

/** O TR gravado na forma do corpo (percentual comparável: `"5.0000"` → `"5"`). */
function conditionsBodyBaseline(term: TermDto): Pick<TermPatch, TermConditionField> {
  const percent = percentText(term.contractGuaranteePercent).replace(',', '.');
  return {
    contractDurationMonths: term.contractDurationMonths,
    executionDeadline: term.executionDeadline,
    executionDeadlineType: term.executionDeadlineType,
    deliveryLocation: term.deliveryLocation,
    paymentTermDays: term.paymentTermDays,
    productWarrantyMonths: term.productWarrantyMonths,
    contractGuaranteePercent: percent === '' ? null : percent,
    allowsSubcontracting: term.allowsSubcontracting ?? false,
    selectionCriterionId: term.selectionCriterionId,
    awardType: term.awardType,
  };
}
