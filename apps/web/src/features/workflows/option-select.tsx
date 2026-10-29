'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@contrataflow/ui';

/** O `Select` do kit não aceita valor vazio: "nenhum" viaja como este marcador. */
const NONE = 'none';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Seleção de uma opção do editor de workflow sobre o `Select` do kit. O valor `''` do rascunho vira
 * o item `noneLabel` (marcador `'none'`); ligado ao `Field` que o contém (rótulo, ajuda e erro).
 */
export function OptionSelect({
  value,
  options,
  onValueChange,
  noneLabel,
  disabled,
  'aria-label': ariaLabel,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onValueChange: (value: string) => void;
  /** Rótulo do item "nenhum"; sem ele a lista só tem as opções. */
  readonly noneLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly 'aria-label'?: string | undefined;
}) {
  return (
    <Select
      value={value === '' && noneLabel !== undefined ? NONE : value}
      onValueChange={(next) => {
        onValueChange(next === NONE ? '' : next);
      }}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {noneLabel === undefined ? null : <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
