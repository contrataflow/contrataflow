import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Primitivos de tabela do design system v2 (prd-4 · padrão 6): caixa com rolagem horizontal,
 * cabeçalho em rótulo 12/600 caixa alta, linhas com hover, ordenação explícita e rodapé com a
 * paginação. A lógica (dados, ordenação, páginas) fica no app.
 */

export interface TableContainerProps extends ComponentPropsWithoutRef<'div'> {
  /** Nome da região rolável (teclado e leitor de tela alcançam a rolagem horizontal). */
  readonly label: string;
  /** Rodapé fora da rolagem (ex.: `TableFooter` com a paginação). */
  readonly footer?: ReactNode;
}

/** Caixa da tabela: borda, raio e rolagem horizontal dentro dela em telas estreitas. */
export function TableContainer({
  label,
  footer,
  className,
  children,
  ...props
}: TableContainerProps) {
  return (
    <div
      className={cx(
        'overflow-hidden rounded-card border border-border bg-surface shadow-card',
        className,
      )}
      {...props}
    >
      {/* Região rolável focável: WCAG 2.1.1 (axe `scrollable-region-focusable`). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- rolagem por teclado. */}
      <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto">
        {children}
      </div>
      {footer}
    </div>
  );
}

export type TableProps = ComponentPropsWithoutRef<'table'>;

export function Table({ className, ...props }: TableProps) {
  return <table className={cx('w-full border-collapse text-sm', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentPropsWithoutRef<'thead'>) {
  return <thead className={cx('bg-muted/60', className)} {...props} />;
}

export function TableBody(props: ComponentPropsWithoutRef<'tbody'>) {
  return <tbody {...props} />;
}

export function Tr({ className, ...props }: ComponentPropsWithoutRef<'tr'>) {
  return (
    <tr
      className={cx(
        'border-b border-border last:border-b-0 [tbody>&]:hover:bg-muted/60',
        className,
      )}
      {...props}
    />
  );
}

export type SortDirection = 'ascending' | 'descending';

export interface ThProps extends ComponentPropsWithoutRef<'th'> {
  /** Coluna ordenável: direção atual (`undefined` = não ordenada por ela). */
  readonly sort?: SortDirection | undefined;
  /** Com ele, o rótulo vira um botão que alterna a ordenação. */
  readonly onSort?: (() => void) | undefined;
}

function SortIcon({ sort }: { readonly sort: SortDirection | undefined }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cx('size-3.5', sort ? 'text-primary' : 'text-muted-foreground')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {sort === 'ascending' ? <path d="m18 15-6-6-6 6" /> : null}
      {sort === 'descending' ? <path d="m6 9 6 6 6-6" /> : null}
      {sort === undefined ? <path d="m7 15 5 5 5-5M7 9l5-5 5 5" /> : null}
    </svg>
  );
}

/** Célula de cabeçalho; ordenável quando recebe `onSort` (`aria-sort` na coluna ordenada). */
export function Th({ sort, onSort, className, children, scope = 'col', ...props }: ThProps) {
  return (
    <th
      scope={scope}
      aria-sort={sort}
      className={cx(
        'px-3.5 py-3 text-left text-label whitespace-nowrap text-muted-foreground uppercase',
        className,
      )}
      {...props}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="-mx-1 inline-flex min-h-6 items-center gap-1 rounded-sm px-1 uppercase hover:text-foreground"
        >
          {children}
          <SortIcon sort={sort} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ className, ...props }: ComponentPropsWithoutRef<'td'>) {
  return <td className={cx('px-3.5 py-3 align-middle', className)} {...props} />;
}

export interface TableFooterProps {
  /** Resumo da página (ex.: "Mostrando 1–7 de 24 processos"). */
  readonly summary?: ReactNode;
  /** Controles de paginação (botões ou links). */
  readonly children?: ReactNode;
  readonly className?: string | undefined;
}

/** Rodapé da tabela: resumo à esquerda, paginação à direita; quebra linha em telas estreitas. */
export function TableFooter({ summary, children, className }: TableFooterProps) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-3 text-sm text-muted-foreground',
        className,
      )}
    >
      {summary ? <span>{summary}</span> : <span />}
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
