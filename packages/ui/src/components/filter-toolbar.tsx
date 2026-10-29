'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Search, SlidersHorizontal } from '../icons.js';
import { Button } from './button.js';
import { FilterChip } from './filter-chip.js';
import { Input } from './input.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';
import { cx } from '../lib/cx.js';

export interface FilterToolbarChip {
  readonly id: string;
  /** Campo e valor (ex.: "Situação: Em andamento"). */
  readonly label: ReactNode;
  /** Nome acessível do botão de remover. */
  readonly removeLabel: string;
  readonly onRemove: () => void;
}

export interface FilterToolbarSortOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterToolbarLabels {
  /** Botão que abre o painel de filtros. */
  readonly filters: string;
  /** Rótulo acessível do contador (ex.: "3 filtros ativos"). */
  readonly activeCount: (count: number) => string;
  readonly clearAll: string;
  /** Nome acessível do seletor de ordenação. */
  readonly sort: string;
  /** Nome da região dos chips ativos. */
  readonly activeFilters: string;
}

export const FILTER_TOOLBAR_LABELS: FilterToolbarLabels = {
  filters: 'Filtros',
  activeCount: (count) => (count === 1 ? '1 filtro ativo' : `${String(count)} filtros ativos`),
  clearAll: 'Limpar filtros',
  sort: 'Ordenar por',
  activeFilters: 'Filtros aplicados',
};

export interface FilterToolbarProps {
  /** Busca inline; omitida quando a lista não tem busca. */
  readonly search?:
    | {
        readonly value: string;
        readonly onChange: (value: string) => void;
        readonly label: string;
        readonly placeholder?: string | undefined;
        /** Dica sob o campo (ex.: "Digite ao menos 2 letras"), ligada por `aria-describedby`. */
        readonly description?: ReactNode;
      }
    | undefined;
  /** Conteúdo do painel "Filtros" (campos do kit); sem ele, o botão não aparece. */
  readonly filters?: ReactNode;
  /**
   * Painel de filtros próprio (ex.: diálogo com "Aplicar"): o botão "Filtros" chama esta função
   * em vez de abrir o popover. Ignorado quando há `filters`.
   */
  readonly onOpenFilters?: ((trigger: HTMLElement) => void) | undefined;
  /** Quantos filtros do painel estão ativos (o número no botão). */
  readonly activeCount?: number | undefined;
  /** Filtros aplicados, como chips removíveis abaixo da barra. */
  readonly chips?: readonly FilterToolbarChip[] | undefined;
  /** Limpa todos os filtros (o link aparece com 2+ chips). */
  readonly onClearAll?: (() => void) | undefined;
  readonly sort?:
    | {
        readonly value: string;
        readonly onValueChange: (value: string) => void;
        readonly options: readonly FilterToolbarSortOption[];
      }
    | undefined;
  /** Ações à direita (ex.: exportar), depois da ordenação. */
  readonly actions?: ReactNode;
  readonly labels?: Partial<FilterToolbarLabels> | undefined;
  readonly className?: string | undefined;
}

/**
 * Barra de filtros das listas (prd-5 · regra 2): busca inline, botão "Filtros" com contador que
 * abre um popover, ordenação e, abaixo, os chips do que está ativo. Filtros fechados por padrão;
 * tudo quebra linha (sem rolagem própria).
 */
export function FilterToolbar({
  search,
  filters,
  onOpenFilters,
  activeCount = 0,
  chips = [],
  onClearAll,
  sort,
  actions,
  labels,
  className,
}: FilterToolbarProps) {
  const text = { ...FILTER_TOOLBAR_LABELS, ...labels };
  const [open, setOpen] = useState(false);
  const hintId = useId();
  const filtersLabel =
    activeCount > 0 ? `${text.filters}, ${text.activeCount(activeCount)}` : undefined;
  const filtersContent = (
    <>
      {text.filters}
      {activeCount > 0 ? (
        <span
          aria-hidden="true"
          className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground"
        >
          {activeCount}
        </span>
      ) : null}
    </>
  );

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2.5">
        {search ? (
          <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1 md:max-w-sm">
            <Input
              type="search"
              icon={<Search />}
              aria-label={search.label}
              aria-describedby={search.description ? hintId : undefined}
              placeholder={search.placeholder}
              value={search.value}
              onChange={(event) => {
                search.onChange(event.target.value);
              }}
            />
            {search.description ? (
              <p id={hintId} className="text-xs text-muted-foreground">
                {search.description}
              </p>
            ) : null}
          </div>
        ) : null}
        {filters ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                iconLeft={<SlidersHorizontal />}
                aria-label={filtersLabel}
              >
                {filtersContent}
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label={text.filters} className="flex w-80 flex-col gap-4">
              {filters}
            </PopoverContent>
          </Popover>
        ) : onOpenFilters ? (
          <Button
            variant="secondary"
            iconLeft={<SlidersHorizontal />}
            aria-haspopup="dialog"
            aria-label={filtersLabel}
            onClick={(event) => {
              onOpenFilters(event.currentTarget);
            }}
          >
            {filtersContent}
          </Button>
        ) : null}
        {sort || actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            {sort ? (
              <Select value={sort.value} onValueChange={sort.onValueChange}>
                <SelectTrigger aria-label={text.sort} className="w-auto min-w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {sort.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
      {chips.length > 0 ? (
        <ul aria-label={text.activeFilters} className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <li key={chip.id}>
              <FilterChip onRemove={chip.onRemove} removeLabel={chip.removeLabel}>
                {chip.label}
              </FilterChip>
            </li>
          ))}
          {onClearAll && chips.length > 1 ? (
            <li>
              <Button variant="link" onClick={onClearAll}>
                {text.clearAll}
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
