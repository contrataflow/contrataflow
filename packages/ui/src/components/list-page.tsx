import type { ReactNode } from 'react';

import { Skeleton } from './skeleton.js';
import { cx } from '../lib/cx.js';

export interface ListPageSummary {
  readonly text: ReactNode;
  readonly actions?: ReactNode;
}

export interface ListPageProps {
  /** Cabeçalho da página (`PageHeader`): título, trilha e a ação primária. */
  readonly header: ReactNode;
  /** Visões da lista (`ViewTabs`). */
  readonly tabs?: ReactNode;
  /** Filtros: `FilterPanel` aberto (prd-6) ou `FilterToolbar` (busca, "Filtros", chips). */
  readonly toolbar?: ReactNode;
  /**
   * Linha de contagem entre os filtros e a tabela (prd-6 §2.4): o texto ("N processos
   * encontrados") à esquerda e as ações (ordenação, colunas) à direita.
   */
  readonly summary?: ListPageSummary | undefined;
  /** Avisos entre a barra e a tabela (alertas, notas de filtro). */
  readonly notices?: ReactNode;
  /** Primeira carga: mostra o esqueleto da tabela no lugar do conteúdo. */
  readonly loading?: boolean | undefined;
  /** Texto anunciado enquanto carrega (leitor de tela). */
  readonly loadingLabel?: string | undefined;
  /** Falha da consulta (ex.: `Alert` com "Tentar novamente"); aparece acima do conteúdo. */
  readonly error?: ReactNode;
  /** Estado vazio (`EmptyState` com ícone, uma frase e uma ação). */
  readonly empty?: ReactNode;
  /** A tabela (`TableContainer` com rodapé de contagem e paginação). */
  readonly children?: ReactNode;
  readonly className?: string | undefined;
}

/**
 * Esqueleto de tabela dos modelos de lista: cabeçalho e oito linhas; com `summary`, a linha de
 * contagem acima da tabela.
 */
export function ListPageSkeleton({
  label,
  rows = 8,
  summary = false,
}: {
  readonly label: string;
  readonly rows?: number;
  readonly summary?: boolean;
}) {
  return (
    <div role="status" className="flex flex-col gap-5">
      <span className="sr-only">{label}</span>
      {summary ? (
        <div className="flex min-h-9 items-center justify-between gap-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-9 w-40" />
        </div>
      ) : null}
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <div className="h-11 border-b border-border bg-muted/40" />
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 border-b border-border px-3.5 py-3.5 last:border-b-0"
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-4 w-28 md:block" />
            <Skeleton className="size-7 flex-none rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Modelo de página de lista (prd-5 · §2 · prd-6 §2.4): cabeçalho → visões → filtros → linha de
 * contagem → avisos → tabela com rodapé de contagem e paginação. Na carga, o esqueleto já traz a
 * linha de contagem (por isso ela some do conteúdo enquanto `loading`). Estados de carga, erro e vazio prontos. Só a página
 * rola: a única rolagem interna permitida é a do `TableContainer` quando a tabela é mais larga.
 */
export function ListPage({
  header,
  tabs,
  toolbar,
  summary,
  notices,
  loading = false,
  loadingLabel = 'Carregando…',
  error,
  empty,
  children,
  className,
}: ListPageProps) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-5', className)}>
      {header}
      {tabs}
      {toolbar}
      {summary && !loading ? (
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm font-semibold text-foreground">{summary.text}</p>
          {summary.actions ? (
            <div className="flex flex-wrap items-center gap-2.5">{summary.actions}</div>
          ) : null}
        </div>
      ) : null}
      {notices}
      {error}
      {loading ? <ListPageSkeleton label={loadingLabel} summary={summary !== undefined} /> : null}
      {empty}
      {children}
    </div>
  );
}
