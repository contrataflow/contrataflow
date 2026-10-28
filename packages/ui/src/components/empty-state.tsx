import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';

export interface EmptyStateProps {
  /** Ícone decorativo (SVG com `aria-hidden`). */
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  /** Por que está vazio e o que fazer. */
  readonly description?: ReactNode;
  /** Próxima ação (botão ou link). */
  readonly action?: ReactNode;
  /** Elemento do título: `p` por padrão, ou um nível de título quando abre uma seção. */
  readonly titleAs?: 'p' | 'h2' | 'h3' | undefined;
  readonly className?: string | undefined;
}

/** Estado vazio (prd-4 · padrão 7): sempre explica e oferece a ação seguinte. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  titleAs: Title = 'p',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-2.5 rounded-card border border-dashed border-border-strong bg-surface px-6 py-8 text-center',
        className,
      )}
    >
      {icon ? (
        <span className="mb-1 grid size-11 place-items-center rounded-control bg-primary-soft text-primary-soft-foreground [&>svg]:size-[1.375rem]">
          {icon}
        </span>
      ) : null}
      <Title className="text-sm font-bold text-brand-ink">{title}</Title>
      {description ? (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-1.5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
