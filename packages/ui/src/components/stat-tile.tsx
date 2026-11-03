import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { PlainLink, TEXT_TONE } from '../lib/tones.js';
import type { LinkComponent, StatusTone } from '../lib/tones.js';

export interface StatTileProps {
  /** Rótulo curto, em caixa alta (ex.: "Pendências"). */
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** Contexto sob o número: texto curto **ou** um `StatusChip`; omitido quando a API não o dá. */
  readonly context?: ReactNode;
  /** Ícone decorativo (SVG com `aria-hidden`) à esquerda do rótulo. */
  readonly icon?: ReactNode;
  readonly tone?: StatusTone | undefined;
  /** Pinta o número na cor do tom (ex.: atrasados em vermelho). */
  readonly emphasizeValue?: boolean | undefined;
  /** Destino da lista filtrada: com ele, o mostrador inteiro é um link. */
  readonly href?: string | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

/**
 * Mostrador compacto (prd-6 §2.1, padrão do Microlegis): rótulo 11/700 em caixa alta, número
 * 26/800 e o contexto. Mais enxuto que o `KpiTile`, para viver dentro de um cartão (o cartão-
 * destaque do painel, os mostradores do calendário): borda de 1 px, sem sombra, então não é um
 * cartão dentro de outro (prd-5 · regra 4). Com `href`, é um link; o nome acessível é o texto.
 */
export function StatTile({
  label,
  value,
  context,
  icon,
  tone = 'info',
  emphasizeValue = false,
  href,
  linkComponent: Link = PlainLink,
  className,
}: StatTileProps) {
  const classes = cx(
    'flex min-w-0 flex-col gap-1.5 rounded-[calc(var(--radius-control)+2px)] border border-border bg-surface px-4 py-3.5 text-foreground',
    href ? 'transition-colors hover:border-primary' : undefined,
    className,
  );
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-[0.6875rem] leading-tight font-bold tracking-[0.06em] text-muted-foreground uppercase [&>svg]:size-3.5 [&>svg]:flex-none">
        {icon}
        {label}
      </span>{' '}
      <span
        className={cx(
          'text-[1.625rem] leading-none font-extrabold tracking-[-0.02em] tabular-nums',
          emphasizeValue ? TEXT_TONE[tone] : 'text-brand-ink',
        )}
      >
        {value}
      </span>{' '}
      {context ? (
        <span className="flex min-w-0 items-center text-xs text-muted-foreground">{context}</span>
      ) : null}
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
