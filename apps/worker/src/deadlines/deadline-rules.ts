import { addCalendarDays, addDays, endOfDayInstant, isBusinessDay } from '@contrataflow/types';

/*
 * Regras puras do job `deadlines` (US-055 · DEC-031 · RN-TRAM-82): "vence em breve" = faltam
 * `deadlines.warnBeforeBusinessDays` dias úteis ou menos até o dia local de `dueAt` — a mesma
 * contagem do `StageDeadlineCalculator` da API (dias úteis DEPOIS de hoje até o dia do prazo,
 * inclusive), para que o aviso e o badge da tela concordem. Datas `YYYY-MM-DD` no fuso do tenant.
 */

/** Feriado como lido do banco (`holidays`). */
export interface HolidayRow {
  readonly date: string;
  readonly scope: string;
  readonly is_active: boolean;
}

/** Datas não úteis por feriado (ativos; `OPTIONAL` só com `calendar.optionalHolidaysAreNonBusiness`). */
export function nonBusinessDatesOf(
  holidays: readonly HolidayRow[],
  optionalAreNonBusiness: boolean,
): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const holiday of holidays) {
    if (!holiday.is_active) continue;
    if (holiday.scope === 'OPTIONAL' && !optionalAreNonBusiness) continue;
    dates.add(holiday.date);
  }
  return dates;
}

/** Última data local que o cálculo pode examinar (folga para fins de semana e feriados). */
export function holidayWindowEnd(today: string, warnBeforeBusinessDays: number): string {
  return addCalendarDays(today, (warnBeforeBusinessDays + 1) * 2 + 60);
}

/**
 * Limite do aviso antecipado: a etapa "vence em breve" quando `dueAt` é ANTERIOR ao início do
 * (`warn + 1`)-ésimo dia útil depois de hoje. `null` = aviso desativado (`warn = 0` — FA-05).
 */
export function dueSoonCutoff(
  today: string,
  warnBeforeBusinessDays: number,
  nonBusiness: ReadonlySet<string>,
  timeZone: string,
): Date | null {
  if (warnBeforeBusinessDays <= 0) return null;
  const firstOutside = addDays(today, warnBeforeBusinessDays + 1, 'BUSINESS', nonBusiness);
  const lastInside = addCalendarDays(firstOutside, -1);
  return new Date(endOfDayInstant(lastInside, timeZone).getTime() + 1);
}

/** Dias úteis de `today` (exclusive) a `dueDate` (inclusive); 0 quando vence hoje. */
export function businessDaysLeft(
  today: string,
  dueDate: string,
  nonBusiness: ReadonlySet<string>,
): number {
  let count = 0;
  for (let date = addCalendarDays(today, 1); date <= dueDate; date = addCalendarDays(date, 1)) {
    if (isBusinessDay(date, nonBusiness)) count += 1;
  }
  return count;
}

/** `deadlines.warnBeforeBusinessDays` gravado (0..10) ou o padrão 2. */
export function warnSettingOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10
    ? value
    : 2;
}
