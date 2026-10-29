import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { PlainLink } from '../lib/tones.js';
import type { LinkComponent } from '../lib/tones.js';

export interface SettingsSection {
  readonly id: string;
  readonly label: ReactNode;
  /** Com `href`, a seção é uma rota; sem, troca por `onSectionChange`. */
  readonly href?: string | undefined;
}

export interface SettingsPageProps {
  /** Cabeçalho (`PageHeader`). */
  readonly header: ReactNode;
  readonly sections: readonly SettingsSection[];
  /** `id` da seção atual. */
  readonly current: string;
  readonly onSectionChange?: ((id: string) => void) | undefined;
  /** Nome acessível da navegação de seções. */
  readonly navLabel: string;
  readonly linkComponent?: LinkComponent | undefined;
  /** Formulário da seção atual. */
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

const ITEM = 'flex min-h-11 items-center rounded-control px-3 text-sm transition-colors';
const ACTIVE = 'bg-primary-soft font-bold text-primary-soft-foreground';
const IDLE = 'font-medium text-foreground hover:bg-muted';

/**
 * Modelo de página de configurações (prd-5 · §2): seções à esquerda (coluna fixa em telas largas,
 * linha que quebra em telas estreitas) e o formulário da seção à direita. A seção atual leva
 * `aria-current`.
 */
export function SettingsPage({
  header,
  sections,
  current,
  onSectionChange,
  navLabel,
  linkComponent: Link = PlainLink,
  children,
  className,
}: SettingsPageProps) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-5', className)}>
      {header}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label={navLabel}>
          <ul className="flex flex-wrap gap-1 lg:sticky lg:top-24 lg:flex-col">
            {sections.map((section) => {
              const active = section.id === current;
              const classes = cx(ITEM, active ? ACTIVE : IDLE);
              return (
                <li key={section.id}>
                  {section.href !== undefined ? (
                    <Link
                      href={section.href}
                      aria-current={active ? 'page' : undefined}
                      className={classes}
                    >
                      {section.label}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      className={cx(classes, 'w-full text-left')}
                      onClick={() => onSectionChange?.(section.id)}
                    >
                      {section.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}
