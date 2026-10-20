import { HOLIDAY_SCOPES } from '@contrataflow/types';
import type { HolidayScope } from '@contrataflow/types';
import { calendarDateSchema } from '@contrataflow/validation';
import type { HolidayDto } from '@contrataflow/validation';

import type { CreateHolidayBody, HolidayPatch } from './calendar.api';

/*
 * Modelo do formulário e da lista do SCR-110 (US-106): conversão formulário ↔ corpo da API,
 * validação com os MESMOS schemas Zod da API e formatação de datas de calendário (`YYYY-MM-DD`,
 * sem fuso — DEC-003). Funções puras, testadas sem DOM.
 */

export const NAME_MAX = 120;

/** Escopos oferecidos no cadastro: `NATIONAL` só nasce do seed (RN-TEN-74). */
export const CREATABLE_SCOPES: readonly HolidayScope[] = ['MUNICIPAL', 'STATE', 'OPTIONAL'];

export interface FormValues {
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope | '';
  readonly isRecurring: boolean;
  readonly isActive: boolean;
}

export type FieldErrors = Readonly<Record<string, string>>;

export function initialValues(holiday?: HolidayDto): FormValues {
  return {
    date: holiday?.date ?? '',
    name: holiday?.name ?? '',
    scope: holiday?.scope ?? '',
    isRecurring: holiday?.isRecurring ?? false,
    isActive: holiday?.isActive ?? true,
  };
}

export interface ValidationMessages {
  readonly required: (field: 'date' | 'name' | 'scope') => string;
  readonly invalidDate: string;
  readonly tooLong: (max: number) => string;
}

/** V-01/V-02 (mesmas regras da API; a API continua sendo a autoridade — RN-FND-92). */
export function validateForm(
  values: FormValues,
  mode: 'create' | 'edit',
  messages: ValidationMessages,
): FieldErrors {
  const errors: Record<string, string> = {};
  if (mode === 'create') {
    if (values.date.trim() === '') errors.date = messages.required('date');
    else if (!calendarDateSchema.safeParse(values.date).success) {
      errors.date = messages.invalidDate;
    }
  }
  const name = values.name.trim();
  if (name === '') errors.name = messages.required('name');
  else if (name.length > NAME_MAX) errors.name = messages.tooLong(NAME_MAX);
  if (values.scope === '') errors.scope = messages.required('scope');
  return errors;
}

export function buildCreateBody(values: FormValues): CreateHolidayBody {
  return {
    date: values.date,
    name: values.name.trim(),
    scope: values.scope as HolidayScope,
    isRecurring: values.isRecurring,
  };
}

/** CAL-03: só o que mudou em relação ao feriado carregado (vazio = nada a salvar). */
export function buildPatch(values: FormValues, holiday: HolidayDto): HolidayPatch {
  const patch: { -readonly [K in keyof HolidayPatch]: HolidayPatch[K] } = {};
  const name = values.name.trim();
  if (name !== holiday.name && !holiday.isSystem) patch.name = name;
  if (values.scope !== '' && values.scope !== holiday.scope) patch.scope = values.scope;
  if (values.isRecurring !== holiday.isRecurring) patch.isRecurring = values.isRecurring;
  if (values.isActive !== holiday.isActive) patch.isActive = values.isActive;
  return patch;
}

/**
 * Escopos que o seletor oferece: no cadastro, os três do administrador; na edição de feriado de
 * sistema, os quatro (ele pode voltar a ser nacional); e o atual sempre aparece.
 */
export function scopeOptions(holiday?: HolidayDto): readonly HolidayScope[] {
  if (holiday?.isSystem) return HOLIDAY_SCOPES;
  if (holiday && !CREATABLE_SCOPES.includes(holiday.scope)) {
    return HOLIDAY_SCOPES.filter(
      (scope) => scope === holiday.scope || CREATABLE_SCOPES.includes(scope),
    );
  }
  return CREATABLE_SCOPES;
}

/** Anos oferecidos no seletor: dois anteriores e três seguintes ao ano corrente (e o escolhido). */
export function yearOptions(currentYear: number, selected: number = currentYear): number[] {
  const years = new Set<number>();
  for (let year = currentYear - 2; year <= currentYear + 3; year += 1) years.add(year);
  years.add(selected);
  return [...years].sort((a, b) => a - b);
}

/** `2026-10-12` → `12/10/2026` (sem converter fuso: a data de calendário é a mesma em todo lugar). */
export function formatHolidayDate(date: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** Dia da semana abreviado (`seg.`) da data de calendário. */
export function weekdayOf(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}
