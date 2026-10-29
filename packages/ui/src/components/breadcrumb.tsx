import type { ReactNode } from 'react';

import { ChevronRight } from '../icons.js';
import { cx } from '../lib/cx.js';
import { PlainLink } from '../lib/tones.js';
import type { LinkComponent } from '../lib/tones.js';

export interface BreadcrumbItem {
  readonly label: ReactNode;
  /** Sem `href`, o item é a página atual (último da trilha). */
  readonly href?: string | undefined;
}

export interface BreadcrumbProps {
  readonly items: readonly BreadcrumbItem[];
  /** Rótulo da `nav` (leitor de tela). */
  readonly label?: string | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

/**
 * Trilha de navegação (shadcn/ui · Breadcrumb): `nav` + lista ordenada, separador `›` decorativo,
 * o último item com `aria-current="page"`. Quebra linha em tela estreita.
 */
export function Breadcrumb({
  items,
  label = 'Trilha',
  linkComponent: Link = PlainLink,
  className,
}: BreadcrumbProps) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={item.href ?? `atual-${String(index)}`} className="flex items-center gap-1">
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
                  className={cx(last ? 'font-semibold text-brand-ink' : undefined)}
                >
                  {item.label}
                </span>
              )}
              {last ? null : <ChevronRight className="size-3.5 flex-none" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
