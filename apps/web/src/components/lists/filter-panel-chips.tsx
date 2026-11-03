'use client';

import { FilterChip } from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/**
 * Chips do rodapé do `FilterPanel` (prd-6 §2.4): só os filtros aplicados por "Mais filtros" — os
 * principais já aparecem preenchidos no próprio cartão. Sem chips, nada é renderizado.
 */
export function FilterPanelChips({
  chips,
  label,
}: {
  readonly chips: readonly FilterToolbarChip[];
  /** Nome da lista de chips; padrão "Outros filtros aplicados". */
  readonly label?: string | undefined;
}) {
  const t = useTranslations('shell.listFilters');
  if (chips.length === 0) return null;
  return (
    <ul aria-label={label ?? t('chips')} className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <li key={chip.id}>
          <FilterChip onRemove={chip.onRemove} removeLabel={chip.removeLabel}>
            {chip.label}
          </FilterChip>
        </li>
      ))}
    </ul>
  );
}
