import type { ReactNode } from 'react';

import { Skeleton } from './skeleton.js';
import { cx } from '../lib/cx.js';

export interface ListPageProps {
  /** Cabeçalho da página (`PageHeader`): título, trilha e a ação primária. */
  readonly header: ReactNode;
  /** Visões da lista (`ViewTabs`). */
  readonly tabs?: ReactNode;
  /** Barra de filtros (`FilterToolbar`): busca, "Filtros", chips e ordenação. */
  readonly toolbar?: ReactNode;
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

/** Esqueleto de tabela dos modelos de lista: cabeçalho e oito linhas. */
export function ListPageSkeleton({
  label,
  rows = 8,
}: {
  readonly label: string;
  readonly rows?: number;
}) {
  return (
    <div role="status" className="overflow-hidden rounded-card bg-surface shadow-card">
      <span className="sr-only">{label}</span>
      <div className="h-11 border-b border-border bg-muted/60" />
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
  );
}

/**
 * Modelo de página de lista (prd-5 · §2): cabeçalho → visões → barra de filtros → avisos →
 * tabela com rodapé de contagem e paginação. Estados de carga, erro e vazio prontos. Só a página
 * rola: a única rolagem interna permitida é a do `TableContainer` quando a tabela é mais larga.
 */
export function ListPage({
  header,
  tabs,
  toolbar,
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
      {notices}
      {error}
      {loading ? <ListPageSkeleton label={loadingLabel} /> : null}
      {empty}
      {children}
    </div>
  );
}
