import {
  addCalendarDays,
  addDays,
  endOfDayInstant,
  isBusinessDay,
  localDateOf,
} from '@contrataflow/types';

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

export { addDays, endOfDayInstant, isBusinessDay, localDateOf };

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
