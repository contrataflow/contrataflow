'use client';

import { DayPicker } from 'react-day-picker';
import type { DayPickerProps } from 'react-day-picker';
import { ptBR } from 'react-day-picker/locale/pt-BR';

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from '../icons.js';
import { buttonClassName } from '../lib/button-class.js';
import { cx } from '../lib/cx.js';

/*
 * Calendário (shadcn/ui sobre `react-day-picker`), em pt-BR com a semana começando no domingo e os
 * rótulos acessíveis da biblioteca ("Hoje, …", "selecionado"). Teclado da grade: setas movem um dia
 * ou uma semana, PageUp/PageDown mudam o mês, Home/End vão ao início/fim da semana, Enter escolhe.
 * Os meses quebram linha em telas estreitas (sem rolagem lateral).
 */

const CHEVRONS = {
  left: ChevronLeft,
  right: ChevronRight,
  up: ChevronUp,
  down: ChevronDown,
} as const;

function CalendarChevron({
  orientation = 'left',
  className,
}: {
  readonly orientation?: keyof typeof CHEVRONS | undefined;
  readonly className?: string | undefined;
}) {
  const Icon = CHEVRONS[orientation];
  return <Icon className={cx('size-4', className)} />;
}

export type CalendarProps = DayPickerProps;

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  locale = ptBR,
  components,
  ...props
}: CalendarProps) {
  const navButton = buttonClassName({
    variant: 'ghost',
    size: 'icon',
    className: 'size-9 text-muted-foreground disabled:text-border-strong',
  });
  return (
    <DayPicker
      locale={locale}
      showOutsideDays={showOutsideDays}
      className={cx('w-fit p-3 text-sm text-foreground', className)}
      classNames={{
        months: 'relative flex flex-wrap gap-6',
        month: 'flex flex-col gap-3',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        button_previous: navButton,
        button_next: navButton,
        month_caption: 'flex h-9 items-center justify-center px-10',
        caption_label: 'text-sm font-bold text-brand-ink first-letter:uppercase',
        month_grid: 'border-collapse',
        weekdays: 'flex',
        weekday: 'w-10 pb-1 text-label text-muted-foreground uppercase',
        week: 'mt-1 flex',
        day: 'relative grid size-10 place-items-center p-0 text-center',
        day_button: cx(
          'grid size-10 place-items-center rounded-control font-medium transition-colors hover:bg-muted',
          'disabled:cursor-not-allowed disabled:hover:bg-transparent',
        ),
        today: 'font-bold text-primary [&>button]:shadow-[inset_0_0_0_1px_var(--color-primary)]',
        selected:
          '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary-hover',
        range_start: 'rounded-l-control bg-primary-soft',
        // O meio do intervalo também é `selected`: o `!` vence o fundo cheio da seleção.
        range_middle:
          'bg-primary-soft [&>button]:bg-transparent! [&>button]:text-primary-soft-foreground! [&>button]:hover:bg-primary-soft!',
        range_end: 'rounded-r-control bg-primary-soft',
        outside: 'text-muted-foreground',
        disabled: 'text-border-strong',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{ Chevron: CalendarChevron, ...components }}
      {...props}
    />
  );
}
