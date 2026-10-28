import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { PlainLink } from '../lib/tones.js';
import type { LinkComponent } from '../lib/tones.js';

export interface BreadcrumbItem {
  readonly label: ReactNode;
  /** Sem `href`, o item é a página atual (último da trilha). */
  readonly href?: string | undefined;
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Trilha de navegação; o último item é a página atual. */
  readonly breadcrumbs?: readonly BreadcrumbItem[] | undefined;
  /** Rótulo da `nav` da trilha (leitor de tela). */
  readonly breadcrumbLabel?: string | undefined;
  /** Ações à direita: a primária por último; filtros ao lado dela. */
  readonly actions?: ReactNode;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

/**
 * Cabeçalho de página (prd-4 · padrão 3): trilha, título 28/800, descrição e ações à direita.
 * Em telas estreitas as ações quebram para baixo do título.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  breadcrumbLabel = 'Trilha',
  actions,
  linkComponent: Link = PlainLink,
  className,
}: PageHeaderProps) {
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label={breadcrumbLabel}>
          <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            {breadcrumbs.map((item, index) => {
              const last = index === breadcrumbs.length - 1;
              return (
                <li
                  key={item.href ?? `atual-${String(index)}`}
                  className="flex items-center gap-1.5"
                >
                  {item.href && !last ? (
                    <Link
                      href={item.href}
                      className="rounded-sm hover:text-primary-hover hover:underline"
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      aria-current={last ? 'page' : undefined}
                      className={last ? 'font-semibold text-brand-ink' : undefined}
                    >
                      {item.label}
                    </span>
                  )}
                  {last ? null : <span aria-hidden="true">/</span>}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-page-title text-brand-ink">{title}</h1>
          {description ? (
            <p className="text-[0.9375rem] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-end gap-2.5">{actions}</div> : null}
      </div>
    </div>
  );
}
