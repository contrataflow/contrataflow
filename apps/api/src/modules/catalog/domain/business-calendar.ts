import { addCalendarDays, dayOfWeek, localDateOf } from '@contrataflow/types';
import type { DayCountType } from '@contrataflow/types';

import type { Holiday } from './holiday.js';

/*
 * Cálculo de dias úteis (US-106 · DEC-031 · RN-TEN-74/78): funções puras sobre datas `YYYY-MM-DD`
 * e um conjunto de datas não úteis. Dia útil é segunda a sexta-feira, exceto data com feriado
 * ativo de escopo `NATIONAL`/`STATE`/`MUNICIPAL` — ou `OPTIONAL` quando o tenant configura
 * `calendar.optionalHolidaysAreNonBusiness = true`. O fuso do tenant (DEC-003) só entra na
 * conversão de/para instantes (`localDateOf`, `endOfDayInstant`), nunca o do servidor.
 */

/** Datas não úteis por feriado (ativos; `OPTIONAL` só se o tenant configurar). */
export function nonBusinessDatesOf(
  holidays: readonly Pick<Holiday, 'date' | 'scope' | 'isActive'>[],
  optionalAreNonBusiness: boolean,
): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const holiday of holidays) {
    if (!holiday.isActive) continue;
    if (holiday.scope === 'OPTIONAL' && !optionalAreNonBusiness) continue;
    dates.add(holiday.date);
  }
  return dates;
}

/** RN-TEN-74: segunda a sexta-feira, fora das datas não úteis. */
export function isBusinessDay(date: string, nonBusiness: ReadonlySet<string>): boolean {
  const weekday = dayOfWeek(date);
  return weekday >= 1 && weekday <= 5 && !nonBusiness.has(date);
}

export { localDateOf };

/** CAL-05: dias úteis de `from` a `to`, ambos inclusos, em ordem. */
export function listBusinessDaysBetween(
  from: string,
  to: string,
  nonBusiness: ReadonlySet<string>,
): string[] {
  const days: string[] = [];
  for (let date = from; date <= to; date = addCalendarDays(date, 1)) {
    if (isBusinessDay(date, nonBusiness)) days.push(date);
  }
  return days;
}

/**
 * RN-TEN-78: data do N-ésimo dia após `from` (o dia de `from` não conta). `BUSINESS` pula fins de
 * semana e datas não úteis; `CALENDAR` soma dias corridos. `days = 0` devolve `from`.
 */
export function addDays(
  from: string,
  days: number,
  type: DayCountType,
  nonBusiness: ReadonlySet<string>,
): string {
  if (type === 'CALENDAR') return addCalendarDays(from, days);
  let date = from;
  let counted = 0;
  while (counted < days) {
    date = addCalendarDays(date, 1);
    if (isBusinessDay(date, nonBusiness)) counted += 1;
  }
  return date;
}

/** Diferença (ms) entre o relógio local do fuso e o UTC no instante dado (positiva a leste). */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Instante (UTC) de `23:59:59.999` do dia local `date` no fuso do tenant (RN-TEN-78). Resolve o
 * deslocamento no próprio instante, o que também cobre fusos com horário de verão.
 */
export function endOfDayInstant(date: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  let guess = wallClockAsUtc - offsetMs(new Date(wallClockAsUtc), timeZone);
  guess = wallClockAsUtc - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}
