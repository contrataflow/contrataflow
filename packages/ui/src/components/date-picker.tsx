'use client';

import { format, isValid, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale/pt-BR';
import { useRef, useState } from 'react';
import type { DateRange } from 'react-day-picker';

import { CalendarDays, X } from '../icons.js';
import { Calendar } from './calendar.js';
import type { CalendarProps } from './calendar.js';
import { fieldControlProps, useFieldControl } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { controlClassName } from '../lib/control-class.js';
import { cx } from '../lib/cx.js';

/*
 * Seletores de data (shadcn/ui: Popover + Calendar), no lugar do `<input type="date">`: o gatilho
 * mostra a data em `dd/MM/aaaa`; Enter/Espaço abrem o calendário com o foco no dia escolhido (ou
 * hoje); setas navegam, Enter escolhe e fecha, `Esc` fecha e devolve o foco ao gatilho. O valor é
 * `Date` (meia-noite local); `toIsoDate`/`fromIsoDate` convertem para o `aaaa-MM-dd` da API.
 */

export type { DateRange };

/** `Date` → `aaaa-MM-dd` (data civil, sem fuso). */
export function toIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** `aaaa-MM-dd` → `Date` local; `undefined` para texto vazio ou inválido. */
export function fromIsoDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = parseISO(value);
  return isValid(date) ? date : undefined;
}

/** Data por extenso curta do gatilho (`dd/MM/aaaa`). */
export function formatDisplayDate(date: Date): string {
  return format(date, 'dd/MM/yyyy', { locale: ptBR });
}

export interface DatePickerLabels {
  /** Texto do gatilho sem data. */
  readonly placeholder: string;
  /** Nome acessível do botão de limpar. */
  readonly clear: string;
  /** Nome acessível do painel do calendário. */
  readonly calendar: string;
}

export const DATE_PICKER_LABELS: DatePickerLabels = {
  placeholder: 'Selecione a data',
  clear: 'Limpar data',
  calendar: 'Escolher data',
};

interface PickerShellProps {
  readonly id?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  /** Ligações de um rótulo/erro externo ao `Field` do kit (ex.: campo próprio de um formulário). */
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  /**
   * Aceito para repassar as ligações de um campo, mas não vai ao gatilho: `aria-required` não é
   * permitido num botão (axe `aria-allowed-attr`); o asterisco do rótulo e a validação o indicam.
   */
  readonly 'aria-required'?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Mostra o botão de limpar quando há valor. */
  readonly clearable?: boolean | undefined;
  readonly className?: string | undefined;
  /** Dias desabilitados (ex.: `{ before: hoje }`), repassado ao `Calendar`. */
  readonly disabledDays?: CalendarProps['disabled'];
}

function TriggerContent({ text, empty }: { readonly text: string; readonly empty: boolean }) {
  return (
    <>
      <CalendarDays className="size-4 flex-none text-muted-foreground" />
      <span className={cx('truncate', empty ? 'text-muted-foreground' : undefined)}>{text}</span>
    </>
  );
}

function ClearButton({ label, onClear }: { readonly label: string; readonly onClear: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClear}
      className="absolute right-1.5 grid size-8 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <X className="size-4" />
    </button>
  );
}

export interface DatePickerProps extends PickerShellProps {
  readonly value: Date | undefined;
  readonly onValueChange: (value: Date | undefined) => void;
  readonly labels?: Partial<DatePickerLabels> | undefined;
}

export function DatePicker({
  value,
  onValueChange,
  labels,
  clearable = false,
  disabledDays,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': _required,
  disabled,
  className,
}: DatePickerProps) {
  const text = { ...DATE_PICKER_LABELS, ...labels };
  const [open, setOpen] = useState(false);
  const field = useFieldControl();
  const { 'aria-required': _fieldRequired, ...control } = fieldControlProps(field, {
    id,
    disabled,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
  });
  const showClear = clearable && value !== undefined && !control.disabled;

  return (
    <div className={cx('relative flex w-full min-w-0 items-center', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={ariaLabel}
            {...control}
            className={controlClassName(
              cx('min-h-11 items-center gap-2 py-2 text-left', showClear ? 'pr-11' : undefined),
            )}
          >
            <TriggerContent
              text={value ? formatDisplayDate(value) : text.placeholder}
              empty={value === undefined}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label={text.calendar} className="w-auto p-0">
          <Calendar
            mode="single"
            // Foco no dia escolhido (ou hoje) ao abrir: o teclado da grade começa ali (WAI-ARIA).
            // eslint-disable-next-line jsx-a11y/no-autofocus -- o calendário abre por ação do usuário.
            autoFocus
            selected={value}
            {...(value ? { defaultMonth: value } : {})}
            {...(disabledDays === undefined ? {} : { disabled: disabledDays })}
            onSelect={(date) => {
              onValueChange(date);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {showClear ? (
        <ClearButton
          label={text.clear}
          onClear={() => {
            onValueChange(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

export interface DateRangePickerLabels extends DatePickerLabels {
  /** Separador entre as datas no gatilho. */
  readonly separator: string;
}

export const DATE_RANGE_PICKER_LABELS: DateRangePickerLabels = {
  placeholder: 'Selecione o período',
  clear: 'Limpar período',
  calendar: 'Escolher período',
  separator: 'a',
};

export interface DateRangePickerProps extends PickerShellProps {
  readonly value: DateRange | undefined;
  readonly onValueChange: (value: DateRange | undefined) => void;
  readonly labels?: Partial<DateRangePickerLabels> | undefined;
  /** Meses lado a lado (quebram linha em tela estreita); 2 por padrão. */
  readonly numberOfMonths?: number | undefined;
}

/** Texto do período no gatilho: "01/10/2026 a 15/10/2026" (ou só o início, durante a escolha). */
export function formatDisplayRange(range: DateRange, separator: string): string {
  if (!range.from) return '';
  if (!range.to) return formatDisplayDate(range.from);
  return `${formatDisplayDate(range.from)} ${separator} ${formatDisplayDate(range.to)}`;
}

export function DateRangePicker({
  value,
  onValueChange,
  labels,
  numberOfMonths = 2,
  clearable = false,
  disabledDays,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  'aria-required': _required,
  disabled,
  className,
}: DateRangePickerProps) {
  const text = { ...DATE_RANGE_PICKER_LABELS, ...labels };
  const [open, setOpen] = useState(false);
  // Cliques desde que o calendário abriu: o primeiro marca o início, o segundo fecha o período.
  const picks = useRef(0);
  const field = useFieldControl();
  const { 'aria-required': _fieldRequired, ...control } = fieldControlProps(field, {
    id,
    disabled,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
  });
  const hasValue = value?.from !== undefined;
  const showClear = clearable && hasValue && !control.disabled;

  return (
    <div className={cx('relative flex w-full min-w-0 items-center', className)}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) picks.current = 0;
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={ariaLabel}
            {...control}
            className={controlClassName(
              cx('min-h-11 items-center gap-2 py-2 text-left', showClear ? 'pr-11' : undefined),
            )}
          >
            <TriggerContent
              text={
                value && hasValue ? formatDisplayRange(value, text.separator) : text.placeholder
              }
              empty={!hasValue}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label={text.calendar} className="w-auto p-0">
          <Calendar
            mode="range"
            // Foco no dia escolhido (ou hoje) ao abrir: o teclado da grade começa ali (WAI-ARIA).
            // eslint-disable-next-line jsx-a11y/no-autofocus -- o calendário abre por ação do usuário.
            autoFocus
            numberOfMonths={numberOfMonths}
            selected={value}
            {...(value?.from ? { defaultMonth: value.from } : {})}
            {...(disabledDays === undefined ? {} : { disabled: disabledDays })}
            onSelect={(range) => {
              onValueChange(range);
              picks.current += 1;
              if (picks.current >= 2 && range?.from && range.to) setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {showClear ? (
        <ClearButton
          label={text.clear}
          onClear={() => {
            onValueChange(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
