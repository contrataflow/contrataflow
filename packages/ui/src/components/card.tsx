import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

export interface CardProps extends Omit<ComponentPropsWithoutRef<'section'>, 'title'> {
  /** Título da seção; com ele, o cartão vira `<section>` rotulada pelo título. */
  readonly title?: ReactNode;
  /** Nível do título (`h2` por padrão; `h3` dentro de outra seção). */
  readonly headingLevel?: 2 | 3 | undefined;
  /** Texto de apoio sob o título. */
  readonly description?: ReactNode;
  /** Ação do cabeçalho, à direita (ex.: link "Ver todas"). */
  readonly action?: ReactNode;
}

/**
 * Cartão do design system v2: superfície branca, borda fina, raio de 14 px e sombra quase nula.
 * Com `title`, ganha cabeçalho com título de seção (16/700) e ação opcional à direita.
 */
export function Card({
  title,
  headingLevel = 2,
  description,
  action,
  className,
  children,
  id,
  ...props
}: CardProps) {
  const classes = cx(
    'flex flex-col gap-4 rounded-card border border-border bg-surface p-5 text-foreground shadow-card',
    className,
  );
  if (title === undefined) {
    return (
      <div id={id} className={classes} {...props}>
        {children}
      </div>
    );
  }
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const headingId = id ? `${id}-titulo` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={classes} {...props}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading id={headingId} className="text-section-title text-brand-ink">
            {title}
          </Heading>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2 text-sm">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
