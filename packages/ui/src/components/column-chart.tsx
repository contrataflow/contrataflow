import type { ReactNode } from 'react';

import { barPercent } from './bar-list.js';
import { cx } from '../lib/cx.js';
import { BAR_TONE } from '../lib/tones.js';
import type { ChartTone } from '../lib/tones.js';

export interface ColumnChartItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly tone?: ChartTone | undefined;
}

export interface ColumnChartProps {
  readonly items: readonly ColumnChartItem[];
  /** Descrição completa para leitor de tela (ex.: "Tempo médio por etapa: DFD 3 dias…"). */
  readonly label: string;
  /** Valor da coluna cheia; padrão: o maior valor. */
  readonly max?: number | undefined;
  readonly formatValue?: ((value: number) => ReactNode) | undefined;
  readonly className?: string | undefined;
}

/**
 * Barras verticais (prd-4 · padrão 5, ex.: tempo médio por etapa): valor sobre a coluna e rótulo
 * abaixo, sempre visíveis; o conjunto é uma imagem rotulada para leitor de tela.
 */
export function ColumnChart({
  items,
  label,
  max,
  formatValue = String,
  className,
}: ColumnChartProps) {
  const full = max ?? Math.max(0, ...items.map((item) => item.value));
  return (
    <div
      role="img"
      aria-label={label}
      className={cx('flex h-[10.625rem] items-end gap-3.5 px-1', className)}
    >
      {items.map((item) => (
        <div key={item.id} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1.5">
          {/* A coluna ocupa a fração da área; encolhe o necessário para o valor caber em cima. */}
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[0.8125rem] font-bold text-brand-ink tabular-nums">
              {formatValue(item.value)}
            </span>
            <span
              className={cx(
                'block min-h-0 w-full max-w-11 shrink rounded-t-lg rounded-b-sm',
                BAR_TONE[item.tone ?? 'info'],
              )}
              style={{ flexBasis: `${String(barPercent(item.value, full))}%` }}
            />
          </div>
          <span className="w-full truncate text-center text-xs text-muted-foreground">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
