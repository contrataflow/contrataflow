import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

/** Faixa de cabeçalho invertida (navy no tema claro) do cartão-destaque (prd-6 §2.5). */
export interface CardHeaderBand {
  /** Selo pequeno antes do título (ex.: "Hoje"). */
  readonly badge?: ReactNode;
  /** Título da faixa (vira o `h2`/`h3` do cartão). */
  readonly title: ReactNode;
  /** Linha de metadados sob o título (ex.: prazos, contagens). */
  readonly meta?: ReactNode;
  /** Só `inverse` por enquanto (`bg-inverse`: navy no claro, claro no escuro — como os toasts). */
  readonly tone?: 'inverse' | undefined;
}

export interface CardProps extends Omit<ComponentPropsWithoutRef<'section'>, 'title'> {
  /** Título da seção; com ele, o cartão vira `<section>` rotulada pelo título. */
  readonly title?: ReactNode;
  /** Nível do título (`h2` por padrão; `h3` dentro de outra seção). */
  readonly headingLevel?: 2 | 3 | undefined;
  /** Texto de apoio sob o título. */
  readonly description?: ReactNode;
  /** Ação do cabeçalho, à direita (ex.: link "Ver todas"). */
  readonly action?: ReactNode;
  /**
   * Cabeçalho invertido: faixa `bg-inverse` antes do corpo, com selo, título e metadados. Com ele,
   * `title`/`description`/`action` são ignorados e o título da faixa rotula a seção.
   */
  readonly header?: CardHeaderBand | undefined;
}

/**
 * Cartão do design system (prd-5 · regra 4 · prd-6): superfície branca, raio de 12 px e a sombra
 * `shadow-card` (contorno de 1 px visível + elevação mínima). Nunca um cartão dentro de outro.
 * Com `title`, ganha cabeçalho com título de seção (16/700) e ação opcional à direita; com
 * `header`, ganha a faixa invertida do cartão-destaque (prd-6 §2.5).
 */
export function Card({
  title,
  headingLevel = 2,
  description,
  action,
  className,
  children,
  id,
  header,
  ...props
}: CardProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const headingId = id ? `${id}-titulo` : undefined;
  if (header) {
    return (
      <section
        id={id}
        aria-labelledby={headingId}
        className={cx(
          'flex flex-col overflow-hidden rounded-card bg-surface text-foreground shadow-card',
          className,
        )}
        {...props}
      >
        <div className="flex flex-col gap-2.5 bg-inverse px-6 py-5 text-inverse-foreground">
          {header.badge ? (
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-inverse-foreground/12 px-2.5 py-0.5 text-xs font-semibold">
              {header.badge}
            </span>
          ) : null}
          <Heading id={headingId} className="text-xl leading-snug font-bold tracking-[-0.01em]">
            {header.title}
          </Heading>
          {header.meta ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-inverse-muted [&_svg]:size-[0.9375rem]">
              {header.meta}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 p-5">{children}</div>
      </section>
    );
  }
  const classes = cx(
    'flex flex-col gap-4 rounded-card bg-surface p-5 text-foreground shadow-card',
    className,
  );
  if (title === undefined) {
    return (
      <div id={id} className={classes} {...props}>
        {children}
      </div>
    );
  }
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
