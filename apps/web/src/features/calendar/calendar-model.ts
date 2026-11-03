import { HOLIDAY_SCOPES, addCalendarDays, dayOfWeek, isoDateToUtc } from '@contrataflow/types';
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

/*
 * Visão do ano (prd-6 §2.6 · padrão do Microlegis): mostradores, legenda, doze meses em grade e a
 * lista lateral. Tudo derivado no cliente dos feriados do ano (CAL-01) e, quando disponível, das
 * datas úteis devolvidas pelo CAL-05 — a fonte que já aplica `calendar.optionalHolidaysAreNonBusiness`
 * (RN-TEN-74). Sem o CAL-05, vale o padrão da configuração: ponto facultativo conta como dia útil.
 */

const yearPrefix = (year: number): string => String(year).padStart(4, '0');

/** Todas as datas `YYYY-MM-DD` do ano, em ordem. */
export function datesOfYear(year: number): string[] {
  const dates: string[] = [];
  const last = `${yearPrefix(year)}-12-31`;
  for (let date = `${yearPrefix(year)}-01-01`; date <= last; date = addCalendarDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

export function isWeekend(date: string): boolean {
  const weekday = dayOfWeek(date);
  return weekday === 0 || weekday === 6;
}

/**
 * Datas sem expediente do ano (segunda a sexta que não são dia útil). Com `businessDates` (CAL-05),
 * é o complemento exato; sem ele, os feriados ativos que não são ponto facultativo (padrão de
 * `calendar.optionalHolidaysAreNonBusiness = false`).
 */
export function nonBusinessDates(
  year: number,
  holidays: readonly HolidayDto[],
  businessDates?: readonly string[],
): Set<string> {
  if (businessDates) {
    const business = new Set(businessDates);
    return new Set(datesOfYear(year).filter((date) => !isWeekend(date) && !business.has(date)));
  }
  return new Set(
    holidays
      .filter((holiday) => holiday.isActive && holiday.scope !== 'OPTIONAL')
      .map((holiday) => holiday.date)
      .filter((date) => date.startsWith(`${yearPrefix(year)}-`) && !isWeekend(date)),
  );
}

export interface YearSummary {
  /** Segunda a sexta fora das datas não úteis: contam nos prazos em dias úteis. */
  readonly businessDays: number;
  /** Segunda a sexta sem expediente (feriado ou ponto facultativo adotado). */
  readonly noWorkDays: number;
  /** Feriados ativos cadastrados pela instituição (não vêm do padrão do sistema). */
  readonly institutionHolidays: number;
  /** Pontos facultativos ativos do ano. */
  readonly optionalHolidays: number;
  /**
   * Se os pontos facultativos em dia de semana contam como dia útil; `null` quando não há nenhum em
   * dia de semana para decidir.
   */
  readonly optionalCountAsBusiness: boolean | null;
}

export function summarizeYear(
  year: number,
  holidays: readonly HolidayDto[],
  nonBusiness: ReadonlySet<string>,
): YearSummary {
  const weekdays = datesOfYear(year).filter((date) => !isWeekend(date));
  const active = holidays.filter((holiday) => holiday.isActive);
  const optional = active.filter((holiday) => holiday.scope === 'OPTIONAL');
  const optionalWeekday = optional.filter((holiday) => !isWeekend(holiday.date));
  return {
    businessDays: weekdays.filter((date) => !nonBusiness.has(date)).length,
    noWorkDays: weekdays.filter((date) => nonBusiness.has(date)).length,
    institutionHolidays: active.filter((holiday) => !holiday.isSystem).length,
    optionalHolidays: optional.length,
    optionalCountAsBusiness:
      optionalWeekday.length === 0
        ? null
        : optionalWeekday.every((holiday) => !nonBusiness.has(holiday.date)),
  };
}

/** Feriados ativos por escopo (contagem da legenda). */
export function countByScope(holidays: readonly HolidayDto[]): Record<HolidayScope, number> {
  const counts: Record<HolidayScope, number> = { NATIONAL: 0, STATE: 0, MUNICIPAL: 0, OPTIONAL: 0 };
  for (const holiday of holidays) if (holiday.isActive) counts[holiday.scope] += 1;
  return counts;
}

/** Semanas do mês (segunda a domingo); `null` preenche os dias fora do mês. */
export function weeksOfMonth(year: number, monthIndex: number): (string | null)[][] {
  const prefix = `${yearPrefix(year)}-${String(monthIndex + 1).padStart(2, '0')}`;
  const first = `${prefix}-01`;
  const cells: (string | null)[] = Array.from({ length: (dayOfWeek(first) + 6) % 7 }, () => null);
  for (let date = first; date.startsWith(prefix); date = addCalendarDays(date, 1)) {
    cells.push(date);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** Feriados por data (ativos primeiro, depois por nome). */
export function holidaysByDate(holidays: readonly HolidayDto[]): Map<string, HolidayDto[]> {
  const byDate = new Map<string, HolidayDto[]>();
  for (const holiday of holidays) {
    const list = byDate.get(holiday.date) ?? [];
    list.push(holiday);
    byDate.set(holiday.date, list);
  }
  for (const list of byDate.values()) {
    list.sort(
      (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'pt-BR'),
    );
  }
  return byDate;
}

/** Filtro da lista lateral. */
export type HolidayFilter = 'all' | 'public' | 'institution' | 'optional';

export const HOLIDAY_FILTERS: readonly HolidayFilter[] = [
  'all',
  'public',
  'institution',
  'optional',
];

/**
 * `public` = feriados oficiais (nacional, estadual, municipal); `institution` = cadastrados pela
 * instituição (não são do padrão do sistema); `optional` = pontos facultativos.
 */
export function matchesFilter(holiday: HolidayDto, filter: HolidayFilter): boolean {
  switch (filter) {
    case 'public':
      return holiday.scope !== 'OPTIONAL';
    case 'institution':
      return !holiday.isSystem;
    case 'optional':
      return holiday.scope === 'OPTIONAL';
    default:
      return true;
  }
}

/** Feriados agrupados por mês (índice 0–11), em ordem de data e nome. */
export function groupByMonth(
  holidays: readonly HolidayDto[],
): { readonly month: number; readonly holidays: readonly HolidayDto[] }[] {
  const sorted = [...holidays].sort(
    (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'pt-BR'),
  );
  const groups: { month: number; holidays: HolidayDto[] }[] = [];
  for (const holiday of sorted) {
    const month = Number(holiday.date.slice(5, 7)) - 1;
    const last = groups.at(-1);
    if (last?.month === month) last.holidays.push(holiday);
    else groups.push({ month, holidays: [holiday] });
  }
  return groups;
}

/** Como o dia entra na contagem de prazos. */
export type DayKind = 'weekend' | 'nonBusiness' | 'business';

export function dayKind(date: string, nonBusiness: ReadonlySet<string>): DayKind {
  if (isWeekend(date)) return 'weekend';
  return nonBusiness.has(date) ? 'nonBusiness' : 'business';
}

/** `2026-04-21` → `terça-feira, 21 de abril de 2026`. */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(isoDateToUtc(date));
}

/** `2026-04-21` → `terça-feira`. */
export function weekdayLong(date: string): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(
    isoDateToUtc(date),
  );
}

/** Nome do mês (`abril`) pelo índice 0–11. */
export function monthName(monthIndex: number): string {
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, monthIndex, 1)),
  );
}
