'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Check, ChevronDown } from '../icons.js';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command.js';
import { fieldControlProps, useFieldControl } from './field.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { controlClassName } from '../lib/control-class.js';
import { cx } from '../lib/cx.js';

/*
 * Combobox (shadcn/ui: Command + Popover): seleção de uma opção numa lista longa, com busca. O
 * gatilho é um botão `role="combobox"`; Enter/Espaço abrem com o foco na busca, setas navegam,
 * Enter escolhe e fecha, `Esc` fecha e devolve o foco. Escolher a opção já marcada a desmarca
 * (quando `clearable`).
 */

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Linha secundária (ex.: CNPJ, unidade). */
  readonly description?: string | undefined;
  /** Termos extras para a busca (ex.: sigla). */
  readonly keywords?: readonly string[] | undefined;
  readonly disabled?: boolean | undefined;
}

export interface ComboboxLabels {
  /** Texto do gatilho sem seleção. */
  readonly placeholder: string;
  /** Placeholder da busca. */
  readonly search: string;
  /** Mensagem sem resultado. */
  readonly empty: string;
}

export const COMBOBOX_LABELS: ComboboxLabels = {
  placeholder: 'Selecione',
  search: 'Buscar',
  empty: 'Nenhum resultado encontrado.',
};

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /** Valor escolhido (`''` ou `undefined` = nenhum). */
  readonly value: string | undefined;
  readonly onValueChange: (value: string | undefined) => void;
  readonly labels?: Partial<ComboboxLabels> | undefined;
  /** Permite desmarcar escolhendo a opção marcada. */
  readonly clearable?: boolean | undefined;
  /** Nome acessível quando não há `Field`/`Label` ligado ao gatilho. */
  readonly 'aria-label'?: string | undefined;
  readonly id?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  /** Conteúdo extra no fim da lista (ex.: "Cadastrar fornecedor"). */
  readonly footer?: ReactNode;
}

export function Combobox({
  options,
  value,
  onValueChange,
  labels,
  clearable = false,
  'aria-label': ariaLabel,
  id,
  disabled,
  className,
  footer,
}: ComboboxProps) {
  const text = { ...COMBOBOX_LABELS, ...labels };
  const [open, setOpen] = useState(false);
  const field = useFieldControl();
  const control = fieldControlProps(field, { id, disabled });
  const selected = options.find((option) => option.value === value);
  const fallbackId = useId();
  const listId = `${control.id ?? fallbackId}-lista`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          {...control}
          className={controlClassName(
            cx(
              'min-h-11 items-center justify-between gap-2 py-2 text-left',
              selected ? undefined : 'text-muted-foreground',
              className,
            ),
          )}
        >
          <span className="truncate">{selected ? selected.label : text.placeholder}</span>
          <ChevronDown className="size-4 flex-none text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={ariaLabel ?? text.search}
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
      >
        <Command label={ariaLabel ?? text.search}>
          <CommandInput placeholder={text.search} />
          <CommandList id={listId}>
            <CommandEmpty>{text.empty}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label, ...(option.keywords ?? [])]}
                    disabled={option.disabled ?? false}
                    onSelect={() => {
                      onValueChange(isSelected && clearable ? undefined : option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    <Check
                      className={cx('text-primary', isSelected ? 'opacity-100' : 'opacity-0')}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {footer}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
