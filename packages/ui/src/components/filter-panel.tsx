'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { ChevronDown, SlidersHorizontal, X } from '../icons.js';
import { Button } from './button.js';
import { cx } from '../lib/cx.js';

export interface FilterPanelLabels {
  /** Nome da região do cartão de filtros. */
  readonly region: string;
  /** Botão que abre/recolhe o cartão em telas estreitas (ex.: "Filtros (2)"). */
  readonly toggle: (activeCount: number) => string;
  /** Botão que abre o painel com os filtros restantes. */
  readonly more: string;
  /** Rótulo acessível do contador de "Mais filtros" (ex.: "Mais filtros, 1 ativo"). */
  readonly moreCount: (count: number) => string;
  readonly clear: string;
}

export const FILTER_PANEL_LABELS: FilterPanelLabels = {
  region: 'Filtros',
  toggle: (count) => (count > 0 ? `Filtros (${String(count)})` : 'Filtros'),
  more: 'Mais filtros',
  moreCount: (count) =>
    count === 1 ? 'Mais filtros, 1 ativo' : `Mais filtros, ${String(count)} ativos`,
  clear: 'Limpar filtros',
};

export interface FilterPanelProps {
  /**
   * Os 3 a 5 filtros principais, cada um num `Field` com um controle do kit. A busca ocupa duas
   * colunas com `className="sm:col-span-2"` no `Field`.
   */
  readonly children: ReactNode;
  /** Quantos filtros estão ativos (principais + "Mais filtros"): habilita "Limpar filtros". */
  readonly activeCount?: number | undefined;
  /** Limpa todos os filtros; sem ele, o botão não aparece. */
  readonly onClear?: (() => void) | undefined;
  /** Abre o painel com os filtros restantes (ex.: `FilterToolbar`/diálogo); sem ele, sem botão. */
  readonly onMore?: ((trigger: HTMLElement) => void) | undefined;
  /** Quantos dos filtros de "Mais filtros" estão ativos (o número no botão). */
  readonly moreCount?: number | undefined;
  /** Conteúdo extra do rodapé, à esquerda (ex.: chips dos filtros de "Mais filtros"). */
  readonly footer?: ReactNode;
  /** Em telas < 768 px o cartão começa recolhido atrás do botão "Filtros (N)". Padrão: `true`. */
  readonly collapsible?: boolean | undefined;
  readonly labels?: Partial<FilterPanelLabels> | undefined;
  readonly className?: string | undefined;
}

/**
 * Cartão de filtros aberto das listas (prd-6 §2.4, padrão do Microlegis — revoga a regra 2 do
 * prd-5 nas listas): os filtros principais em grade rotulada e, no rodapé, "Mais filtros" e
 * "Limpar filtros". Em telas estreitas começa recolhido; o recolhimento é só de CSS abaixo de
 * `md` (sem medir a tela), então o servidor e o cliente renderizam o mesmo HTML. Sem rolagem
 * própria (prd-5 · regra 8).
 */
export function FilterPanel({
  children,
  activeCount = 0,
  onClear,
  onMore,
  moreCount = 0,
  footer,
  collapsible = true,
  labels,
  className,
}: FilterPanelProps) {
  const text = { ...FILTER_PANEL_LABELS, ...labels };
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const hasActions = Boolean(onMore ?? onClear);

  return (
    <section
      aria-label={text.region}
      className={cx('flex flex-col rounded-card bg-surface text-foreground shadow-card', className)}
    >
      {collapsible ? (
        <div className={cx('p-4 md:hidden', open ? 'pb-0' : undefined)}>
          <Button
            variant="secondary"
            className="w-full justify-between"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            <span className="inline-flex items-center gap-2">
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {text.toggle(activeCount)}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cx('size-4 transition-transform', open ? 'rotate-180' : undefined)}
            />
          </Button>
        </div>
      ) : null}
      <div
        id={contentId}
        className={cx(
          'flex-col gap-4 p-5',
          collapsible ? (open ? 'flex md:flex' : 'hidden md:flex') : 'flex',
        )}
      >
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
          {children}
        </div>
        {hasActions || footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {footer ? (
              <div className="mr-auto flex flex-wrap items-center gap-2">{footer}</div>
            ) : null}
            {onMore ? (
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<SlidersHorizontal />}
                aria-haspopup="dialog"
                aria-label={moreCount > 0 ? text.moreCount(moreCount) : undefined}
                onClick={(event) => {
                  onMore(event.currentTarget);
                }}
              >
                {text.more}
                {moreCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground"
                  >
                    {moreCount}
                  </span>
                ) : null}
              </Button>
            ) : null}
            {onClear ? (
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<X />}
                disabled={activeCount === 0}
                onClick={onClear}
              >
                {text.clear}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
