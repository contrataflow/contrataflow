import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { BAR_TONE, PlainLink } from '../lib/tones.js';
import type { ChartTone, LinkComponent } from '../lib/tones.js';

export interface BarListItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly tone?: ChartTone | undefined;
  /** Destino da lista filtrada pelo item. */
  readonly href?: string | undefined;
}

export interface BarListProps {
  readonly items: readonly BarListItem[];
  /** Valor da barra cheia; padrão: o maior valor da lista. */
  readonly max?: number | undefined;
  readonly formatValue?: ((value: number) => ReactNode) | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

/** Fração de `value` sobre `max`, em % (0–100); `max` zero ou negativo → 0. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

/**
 * Barras horizontais com rótulo e valor (prd-4 · padrão 5): uma lista de texto em que a barra é só
 * reforço visual — rótulo e número sempre visíveis e lidos pelo leitor de tela.
 */
export function BarList({
  items,
  max,
  formatValue = String,
  linkComponent: Link = PlainLink,
  className,
}: BarListProps) {
  const full = max ?? Math.max(0, ...items.map((item) => item.value));
  return (
    <ul className={cx('flex flex-col gap-3', className)}>
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1.5">
          <span className="flex items-baseline justify-between gap-3 text-[0.8125rem] text-foreground">
            {item.href ? (
              <Link href={item.href} className="hover:text-primary-hover hover:underline">
                {item.label}
              </Link>
            ) : (
              <span>{item.label}</span>
            )}{' '}
            <span className="font-bold text-brand-ink tabular-nums">{formatValue(item.value)}</span>
          </span>
          <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className={cx('block h-full rounded-full', BAR_TONE[item.tone ?? 'info'])}
              style={{ width: `${String(barPercent(item.value, full))}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
