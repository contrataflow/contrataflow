/**
 * Calendário de dias úteis (US-106 · entities.md §2 `HolidayScope`/`DayCountType`, §7 seed de
 * calendário): listas fechadas e a parte determinística do cálculo (Páscoa e feriados do ano),
 * compartilhadas pela API (seeder, soma de dias úteis), pelo worker (geração do ano seguinte) e
 * pelo web (SCR-110). Datas são `YYYY-MM-DD`, sem fuso (DEC-003).
 */

/** entities.md §2 — `HolidayScope`. `OPTIONAL` = ponto facultativo. */
export const HOLIDAY_SCOPES = ['NATIONAL', 'STATE', 'MUNICIPAL', 'OPTIONAL'] as const;

export type HolidayScope = (typeof HOLIDAY_SCOPES)[number];

/** Escopos que o administrador pode cadastrar (`NATIONAL` só nasce do seeder — RN-TEN-74). */
export const MANAGED_HOLIDAY_SCOPES = ['STATE', 'MUNICIPAL', 'OPTIONAL'] as const;

/** `HolidayChanged.change` (events.md §4.5). */
export const HOLIDAY_CHANGES = ['CREATED', 'UPDATED', 'DELETED'] as const;

export type HolidayChange = (typeof HOLIDAY_CHANGES)[number];

/** entities.md §2 — `DayCountType`. */
export const DAY_COUNT_TYPES = ['BUSINESS', 'CALENDAR'] as const;

export type DayCountType = (typeof DAY_COUNT_TYPES)[number];

/** `CAL-06`: faixa aceita de `businessDays` (V-05). */
export const MAX_ADD_BUSINESS_DAYS = 1000;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → instante UTC à meia-noite (aritmética de calendário sem fuso). */
export function isoDateToUtc(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function utcToIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Soma `days` (positivo ou negativo) dias corridos a uma data `YYYY-MM-DD`. */
export function addCalendarDays(date: string, days: number): string {
  return utcToIsoDate(new Date(isoDateToUtc(date).getTime() + days * DAY_MS));
}

/** Dia da semana de uma data `YYYY-MM-DD` (0 = domingo … 6 = sábado). */
export function dayOfWeek(date: string): number {
  return isoDateToUtc(date).getUTCDay();
}

/**
 * Domingo de Páscoa do ano gregoriano (algoritmo anônimo de Meeus/Jones/Butcher — RN-TEN-76),
 * como `YYYY-MM-DD`. Válido para qualquer ano gregoriano (> 1582).
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Feriado do seed de calendário (entities.md §7). */
export interface SeedHoliday {
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope;
  /** Todos os do seed são recorrentes: o job de manutenção gera o ano seguinte (RN-TEN-76). */
  readonly isRecurring: true;
}

const FIXED_NATIONAL: readonly (readonly [string, string])[] = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  // Lei 14.759/2023.
  ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['12-25', 'Natal'],
];

/**
 * Feriados semeados para o ano (entities.md §7): nacionais de data fixa e Sexta-feira Santa
 * (Páscoa − 2, `MUNICIPAL` sugerido para revisão do órgão); Carnaval (2ª e 3ª), Quarta-feira de
 * Cinzas e Corpus Christi como pontos facultativos (`OPTIONAL`). Ordenados por data.
 */
export function seedHolidaysOf(year: number): SeedHoliday[] {
  const easter = easterSunday(year);
  const y = String(year).padStart(4, '0');
  const holidays: SeedHoliday[] = [
    ...FIXED_NATIONAL.map(([monthDay, name]) => ({
      date: `${y}-${monthDay}`,
      name,
      scope: 'NATIONAL' as const,
      isRecurring: true as const,
    })),
    {
      date: addCalendarDays(easter, -48),
      name: 'Carnaval (segunda-feira)',
      scope: 'OPTIONAL',
      isRecurring: true,
    },
    {
      date: addCalendarDays(easter, -47),
      name: 'Carnaval (terça-feira)',
      scope: 'OPTIONAL',
      isRecurring: true,
    },
    {
      date: addCalendarDays(easter, -46),
      name: 'Quarta-feira de Cinzas',
      scope: 'OPTIONAL',
      isRecurring: true,
    },
    {
      date: addCalendarDays(easter, -2),
      name: 'Sexta-feira Santa',
      scope: 'MUNICIPAL',
      isRecurring: true,
    },
    {
      date: addCalendarDays(easter, 60),
      name: 'Corpus Christi',
      scope: 'OPTIONAL',
      isRecurring: true,
    },
  ];
  return holidays.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** Nomes dos feriados móveis do seed (recalculados a cada ano — RN-TEN-76). */
export const MOVABLE_HOLIDAY_NAMES: readonly string[] = [
  'Carnaval (segunda-feira)',
  'Carnaval (terça-feira)',
  'Quarta-feira de Cinzas',
  'Sexta-feira Santa',
  'Corpus Christi',
];

/** Data local (`YYYY-MM-DD`) de um instante no fuso IANA (DEC-003); `en-CA` formata como ISO. */
export function localDateOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** RN-TEN-74: segunda a sexta-feira, fora das datas não úteis (feriados do tenant). */
export function isBusinessDay(date: string, nonBusiness: ReadonlySet<string>): boolean {
  const weekday = dayOfWeek(date);
  return weekday >= 1 && weekday <= 5 && !nonBusiness.has(date);
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

/**
 * RN-PROC-98 (US-008 · DEC-031): dias úteis (ou corridos) no intervalo `[from, to)` — o dia de
 * `from` conta e o de `to`, não. `from >= to` (mesma data local) = 0. Base da extensão do prazo
 * na retomada de um processo suspenso, na API e na prévia do diálogo (SCR-116).
 */
export function daysInInterval(
  from: string,
  to: string,
  type: DayCountType,
  nonBusiness: ReadonlySet<string>,
): number {
  if (from >= to) return 0;
  if (type === 'CALENDAR') {
    return Math.round((isoDateToUtc(to).getTime() - isoDateToUtc(from).getTime()) / DAY_MS);
  }
  let count = 0;
  for (let date = from; date < to; date = addCalendarDays(date, 1)) {
    if (isBusinessDay(date, nonBusiness)) count += 1;
  }
  return count;
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

/** Ocorrência de feriado recorrente já existente (fonte da geração do ano seguinte). */
export interface RecurringHolidaySource {
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope;
  readonly isActive: boolean;
  readonly isSystem: boolean;
}

export interface PlannedHoliday {
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope;
  readonly isActive: boolean;
  readonly isSystem: boolean;
}

const MOVABLE: ReadonlySet<string> = new Set(MOVABLE_HOLIDAY_NAMES);

/**
 * Geração do ano `year` a partir dos feriados recorrentes (RN-TEN-76 · job de manutenção): para
 * cada nome (sem diferenciar maiúsculas), a ocorrência mais recente ANTERIOR ao ano gera a do ano
 * — escopo, situação (`isActive`) e condição de sistema herdados, para respeitar o que o
 * administrador ajustou. Os móveis de sistema (Carnaval, Cinzas, Sexta-feira Santa, Corpus
 * Christi) têm a data recalculada pela Páscoa (Meeus/Butcher); os demais repetem dia e mês
 * (29/02 vira 28/02 em ano não bissexto). Ordenado por data; não consulta nem grava nada.
 */
export function planRecurringHolidays(
  sources: readonly RecurringHolidaySource[],
  year: number,
): PlannedHoliday[] {
  const y = String(year).padStart(4, '0');
  const latest = new Map<string, RecurringHolidaySource>();
  for (const source of sources) {
    if (source.date >= `${y}-01-01`) continue;
    const key = source.name.toLowerCase();
    const known = latest.get(key);
    if (known === undefined || source.date > known.date) latest.set(key, source);
  }
  const movableDates = new Map(seedHolidaysOf(year).map((seed) => [seed.name, seed.date]));
  const planned: PlannedHoliday[] = [];
  for (const source of latest.values()) {
    let date: string | undefined;
    if (source.isSystem && MOVABLE.has(source.name)) {
      date = movableDates.get(source.name);
    } else {
      const monthDay = source.date.slice(5);
      const isLeapDay = monthDay === '02-29';
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      date = `${y}-${isLeapDay && !leap ? '02-28' : monthDay}`;
    }
    if (date === undefined) continue;
    planned.push({
      date,
      name: source.name,
      scope: source.scope,
      isActive: source.isActive,
      isSystem: source.isSystem,
    });
  }
  return planned.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
