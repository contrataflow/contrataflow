'use client';

import { cx } from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import { dayKind, longDate, monthName, weeksOfMonth } from './calendar-model';
import { HolidayMarker } from './holiday-marker';

export interface YearGridProps {
  readonly year: number;
  /** Data de hoje (`YYYY-MM-DD`), para o contorno do dia. */
  readonly today: string;
  readonly byDate: ReadonlyMap<string, readonly HolidayDto[]>;
  readonly nonBusiness: ReadonlySet<string>;
  /** Com `CALENDAR_MANAGE`, cada dia é um botão que abre o diálogo (edição ou cadastro). */
  readonly onDay?: ((date: string) => void) | undefined;
}

/** Cabeçalho da semana (segunda a domingo): letra visível, nome completo para leitor de tela. */
const WEEKDAYS: readonly (readonly [string, string])[] = [
  ['S', 'segunda-feira'],
  ['T', 'terça-feira'],
  ['Q', 'quarta-feira'],
  ['Q', 'quinta-feira'],
  ['S', 'sexta-feira'],
  ['S', 'sábado'],
  ['D', 'domingo'],
];

/**
 * Doze meses em grade (prd-6 §2.6, padrão do Microlegis): cada mês num cartão com o nome e
 * "n datas", dias de segunda a domingo, fim de semana em `muted`, hoje com contorno, dia sem
 * expediente em `primary-soft`, feriado com o marcador do tipo e ponto facultativo que conta como
 * dia útil tracejado. Com `onDay`, cada dia é um botão com o rótulo completo e as setas navegam
 * dentro do mês (um único dia por mês entra na ordem de tabulação). Sem rolagem própria.
 */
export function YearGrid({ year, today, byDate, nonBusiness, onDay }: YearGridProps) {
  const t = useTranslations('calendar');
  const [focused, setFocused] = useState<string | null>(null);

  const dayLabel = (date: string): string => {
    const parts = [longDate(date)];
    for (const holiday of byDate.get(date) ?? []) {
      parts.push(
        holiday.isActive
          ? `${holiday.name} · ${t(`scopeLong.${holiday.scope}`).toLowerCase()}`
          : `${holiday.name} · ${t(`scopeLong.${holiday.scope}`).toLowerCase()} (${t('day.inactive')})`,
      );
    }
    if (date === today) parts.push(t('day.today'));
    return parts.join(' · ');
  };

  /** Setas (±1 dia, ±1 semana), Home e End movem o foco entre os dias do mesmo mês. */
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: string,
    dates: readonly string[],
  ) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let target: string | undefined;
    if (step !== undefined) target = dates[dates.indexOf(current) + step];
    else if (event.key === 'Home') target = dates[0];
    else if (event.key === 'End') target = dates.at(-1);
    if (!target) return;
    event.preventDefault();
    setFocused(target);
    event.currentTarget
      .closest('table')
      ?.querySelector<HTMLButtonElement>(`[data-date="${target}"]`)
      ?.focus();
  };

  return (
    <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
      {Array.from({ length: 12 }, (_, month) => {
        const weeks = weeksOfMonth(year, month);
        const dates = weeks.flat().filter((date): date is string => date !== null);
        const marked = dates.filter((date) =>
          (byDate.get(date) ?? []).some((holiday) => holiday.isActive),
        ).length;
        // Dia que entra na tabulação: o focado, senão hoje, senão o primeiro feriado, senão o dia 1.
        const anchor =
          [focused, today].find((date) => date !== null && dates.includes(date)) ??
          dates.find((date) => byDate.has(date)) ??
          dates[0];
        const headingId = `mes-${String(year)}-${String(month + 1)}`;
        return (
          <li
            key={month}
            className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-3.5 shadow-card"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={headingId} className="text-sm font-bold text-foreground capitalize">
                {monthName(month)}
              </h3>
              <span className="text-xs text-muted-foreground">
                {t('months.dates', { count: marked })}
              </span>
            </div>
            <table
              aria-labelledby={headingId}
              className="w-full table-fixed border-separate border-spacing-0.5 text-center text-xs tabular-nums"
            >
              <thead>
                <tr>
                  {WEEKDAYS.map(([letter, name]) => (
                    <th
                      key={name}
                      scope="col"
                      className="pb-1 text-[0.6875rem] font-bold text-muted-foreground"
                    >
                      <span aria-hidden="true">{letter}</span>
                      <span className="sr-only">{name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, index) => (
                  <tr key={index}>
                    {week.map((date, column) => (
                      <td key={date ?? `vazio-${String(column)}`} className="p-0">
                        {date ? (
                          <Day
                            date={date}
                            label={dayLabel(date)}
                            holidays={byDate.get(date) ?? []}
                            kind={dayKind(date, nonBusiness)}
                            isToday={date === today}
                            tabbable={date === anchor}
                            onDay={onDay}
                            onFocus={() => {
                              setFocused(date);
                            }}
                            onKeyDown={(event) => {
                              onKeyDown(event, date, dates);
                            }}
                          />
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        );
      })}
    </ol>
  );
}

function Day({
  date,
  label,
  holidays,
  kind,
  isToday,
  tabbable,
  onDay,
  onFocus,
  onKeyDown,
}: {
  readonly date: string;
  readonly label: string;
  readonly holidays: readonly HolidayDto[];
  readonly kind: ReturnType<typeof dayKind>;
  readonly isToday: boolean;
  readonly tabbable: boolean;
  readonly onDay: ((date: string) => void) | undefined;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const active = holidays.find((holiday) => holiday.isActive);
  const classes = cx(
    'relative flex h-8 w-full items-center justify-center rounded-[0.375rem]',
    kind === 'weekend' && 'bg-muted text-muted-foreground',
    kind === 'nonBusiness' && 'bg-primary-soft font-bold text-primary-soft-foreground',
    kind === 'business' && 'text-foreground',
    kind === 'business' &&
      active &&
      'font-bold outline-1 -outline-offset-1 outline-border outline-dashed',
    isToday && 'ring-2 ring-foreground ring-inset',
  );
  const content = (
    <>
      <span aria-hidden="true">{Number(date.slice(8))}</span>
      {active ? (
        <HolidayMarker
          scope={active.scope}
          className="absolute top-0.5 right-0.5 size-[0.4375rem]"
        />
      ) : null}
    </>
  );
  if (!onDay) {
    return (
      <span className={classes} data-date={date}>
        {content}
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-date={date}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={() => {
        onDay(date);
      }}
      className={cx(
        classes,
        'hover:ring-2 hover:ring-primary/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid',
      )}
    >
      {content}
    </button>
  );
}
