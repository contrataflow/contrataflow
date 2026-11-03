'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@contrataflow/ui';

/**
 * Ordenação na linha de contagem das listas (prd-6 §2.4 · `ListPage.summary.actions`): o mesmo
 * select que a `FilterToolbar` oferecia, agora à direita da contagem.
 */
export function ListSortSelect({
  value,
  onValueChange,
  options,
  label,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** Nome acessível (ex.: "Ordenar por"). */
  readonly label: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label} className="w-auto min-w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
