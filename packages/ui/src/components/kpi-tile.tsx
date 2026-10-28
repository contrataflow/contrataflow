import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { PlainLink, SOFT_TONE, TEXT_TONE } from '../lib/tones.js';
import type { LinkComponent, StatusTone } from '../lib/tones.js';

export interface KpiTileProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Contexto do número (o que conta, prazo); omitido quando a API não o fornece. */
  readonly context?: ReactNode;
  /** Ícone decorativo (SVG com `aria-hidden`), sobre o fundo suave do tom. */
  readonly icon?: ReactNode;
  readonly tone?: StatusTone | undefined;
  /** Pinta o número na cor do tom (ex.: atrasados em vermelho). */
  readonly emphasizeValue?: boolean | undefined;
  /** Destino da lista filtrada: com ele, o cartão inteiro é um link. */
  readonly href?: string | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

/**
 * Cartão de KPI (prd-4 · padrão 4): rótulo, ícone colorido, número grande (34/800) e contexto. Com
 * `href`, é um link para a lista filtrada; o nome acessível é o texto do cartão.
 */
export function KpiTile({
  label,
  value,
  context,
  icon,
  tone = 'info',
  emphasizeValue = false,
  href,
  linkComponent: Link = PlainLink,
  className,
}: KpiTileProps) {
  const classes = cx(
    'flex flex-col gap-3.5 rounded-card border border-border bg-surface p-5 text-foreground shadow-card',
    href ? 'transition-colors hover:border-primary' : undefined,
    className,
  );
  const content = (
    <>
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {icon ? (
          <span
            className={cx(
              'grid size-9 flex-none place-items-center rounded-control [&>svg]:size-[1.125rem]',
              SOFT_TONE[tone],
            )}
          >
            {icon}
          </span>
        ) : null}
      </span>{' '}
      <span className={cx('text-kpi', emphasizeValue ? TEXT_TONE[tone] : 'text-brand-ink')}>
        {value}
      </span>{' '}
      {context ? <span className="text-[0.8125rem] text-muted-foreground">{context}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return <div className={classes}>{content}</div>;
}
