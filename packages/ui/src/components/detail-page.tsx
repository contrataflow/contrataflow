import type { ReactNode, Ref } from 'react';

import { Breadcrumb } from './breadcrumb.js';
import type { BreadcrumbItem } from './breadcrumb.js';
import { cx } from '../lib/cx.js';
import { PlainLink } from '../lib/tones.js';
import type { LinkComponent } from '../lib/tones.js';

export interface DetailFact {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
}

export interface DetailPageProps {
  /** Trilha; o último item é a página atual. */
  readonly breadcrumbs?: readonly BreadcrumbItem[] | undefined;
  readonly breadcrumbLabel?: string | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly title: ReactNode;
  /** Com ref, o título recebe `tabIndex=-1` para receber o foco ao carregar. */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  /** Chips de situação ao lado do título. */
  readonly status?: ReactNode;
  /** Linha de identificação sob o título (número · modalidade · unidade · data). */
  readonly subtitle?: ReactNode;
  /** Ação primária por último, precedida de "Mais" (prd-5 · regra 1). */
  readonly actions?: ReactNode;
  /** Barra de etapas (`StageProgress`), no topo do cartão de fatos. */
  readonly progress?: ReactNode;
  /** Fatos-chave em linha (etapa, responsável, prazo, valor…). */
  readonly facts?: readonly DetailFact[] | undefined;
  /** Conteúdo extra do cartão de fatos, abaixo deles (etiquetas, atalhos). */
  readonly factsExtra?: ReactNode;
  /** Avisos entre o cabeçalho e as abas. */
  readonly notices?: ReactNode;
  /** Abas da página (`Tabs`/`ViewTabs`). */
  readonly tabs?: ReactNode;
  /** Conteúdo principal (2/3 com `aside`; largura toda sem ele). */
  readonly children?: ReactNode;
  /** Coluna lateral (1/3); abaixo do conteúdo em telas estreitas. */
  readonly aside?: ReactNode;
  /** Nome da coluna lateral (leitor de tela). */
  readonly asideLabel?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Grade do detalhe (prd-5 · §2): conteúdo em 2/3 e coluna lateral em 1/3 a partir de 1024 px; em
 * telas estreitas a coluna lateral desce para baixo do conteúdo.
 */
export function DetailGrid({
  children,
  aside,
  asideLabel,
  className,
}: {
  readonly children: ReactNode;
  readonly aside?: ReactNode;
  /** Nome da região lateral (leitor de tela). */
  readonly asideLabel?: string | undefined;
  readonly className?: string | undefined;
}) {
  if (!aside) return <div className={cx('flex min-w-0 flex-col gap-5', className)}>{children}</div>;
  return (
    <div className={cx('grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]', className)}>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      <aside aria-label={asideLabel} className="flex min-w-0 flex-col gap-5">
        {aside}
      </aside>
    </div>
  );
}

/**
 * Modelo de página de detalhe (prd-5 · regra 5): faixa de cabeçalho com trilha, título, chips de
 * situação, linha de identificação e ação primária + "Mais"; cartão com a barra de etapas e os
 * fatos-chave em linha; avisos; abas; grade 2/3 + 1/3. Nada rola por dentro.
 */
export function DetailPage({
  breadcrumbs,
  breadcrumbLabel = 'Trilha',
  linkComponent = PlainLink,
  title,
  titleRef,
  status,
  subtitle,
  actions,
  progress,
  facts = [],
  factsExtra,
  notices,
  tabs,
  children,
  aside,
  asideLabel,
  className,
}: DetailPageProps) {
  const hasCard = Boolean(progress) || facts.length > 0 || Boolean(factsExtra);
  return (
    <div className={cx('flex min-w-0 flex-col gap-5', className)}>
      <header className="flex min-w-0 flex-col gap-3">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <Breadcrumb items={breadcrumbs} label={breadcrumbLabel} linkComponent={linkComponent} />
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-[1_1_20rem] flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h1
                ref={titleRef}
                tabIndex={titleRef ? -1 : undefined}
                className="min-w-0 text-page-title break-words text-brand-ink outline-none"
              >
                {title}
              </h1>
              {status}
            </div>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          {actions ? (
            <div className="flex flex-none flex-wrap items-start gap-2">{actions}</div>
          ) : null}
        </div>
      </header>
      {hasCard ? (
        <div className="flex min-w-0 flex-col gap-5 rounded-card bg-surface p-5 shadow-card">
          {progress}
          {facts.length > 0 ? (
            <dl
              className={cx(
                'flex flex-wrap gap-x-8 gap-y-4',
                progress ? 'border-t border-border pt-4' : undefined,
              )}
            >
              {facts.map((fact) => (
                <div key={fact.id} className="flex min-w-0 flex-col gap-1">
                  <dt className="text-label font-semibold text-muted-foreground uppercase">
                    {fact.label}
                  </dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {factsExtra}
        </div>
      ) : null}
      {notices}
      {tabs}
      {children || aside ? (
        <DetailGrid aside={aside} asideLabel={asideLabel}>
          {children}
        </DetailGrid>
      ) : null}
    </div>
  );
}
