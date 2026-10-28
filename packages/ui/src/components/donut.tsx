import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { BAR_TONE, STROKE_TONE } from '../lib/tones.js';
import type { ChartTone } from '../lib/tones.js';

export interface DonutSegment {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly tone: ChartTone;
}

export interface DonutProps {
  readonly segments: readonly DonutSegment[];
  /** Descrição completa do gráfico para leitor de tela (ex.: "24 processos: 11 em andamento…"). */
  readonly label: string;
  /** Número no centro (ex.: o total) e a legenda dele. */
  readonly centerValue?: ReactNode;
  readonly centerLabel?: ReactNode;
  readonly formatValue?: ((value: number) => ReactNode) | undefined;
  readonly className?: string | undefined;
}

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface DonutArc {
  readonly id: string;
  readonly tone: ChartTone;
  /** Comprimento do arco no traço do círculo. */
  readonly length: number;
  /** Deslocamento (negativo) do início do arco. */
  readonly offset: number;
}

/** Arcos das fatias com valor positivo, na ordem dada, somando a circunferência inteira. */
export function donutArcs(segments: readonly DonutSegment[]): DonutArc[] {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  if (total <= 0) return [];
  let start = 0;
  return segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const length = (segment.value / total) * CIRCUMFERENCE;
      const arc = { id: segment.id, tone: segment.tone, length, offset: -start };
      start += length;
      return arc;
    });
}

/**
 * Donut de situação (prd-4 · padrão 5), em SVG próprio: `role="img"` com a descrição completa, e
 * legenda em texto ao lado — a cor nunca é a única informação.
 */
export function Donut({
  segments,
  label,
  centerValue,
  centerLabel,
  formatValue = String,
  className,
}: DonutProps) {
  const arcs = donutArcs(segments);
  return (
    <div className={cx('flex flex-wrap items-center gap-5', className)}>
      <div className="relative size-[9.375rem] flex-none">
        <svg viewBox="0 0 100 100" role="img" aria-label={label} className="size-full">
          <g transform="rotate(-90 50 50)" fill="none" strokeWidth="14">
            <circle cx="50" cy="50" r={RADIUS} className="stroke-muted" />
            {arcs.map((arc) => (
              <circle
                key={arc.id}
                cx="50"
                cy="50"
                r={RADIUS}
                className={STROKE_TONE[arc.tone]}
                strokeDasharray={`${arc.length.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
                strokeDashoffset={arc.offset.toFixed(2)}
              />
            ))}
          </g>
        </svg>
        {centerValue === undefined ? null : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
          >
            <span className="text-[1.875rem] leading-none font-extrabold text-brand-ink">
              {centerValue}
            </span>
            {centerLabel ? (
              <span className="text-xs text-muted-foreground">{centerLabel}</span>
            ) : null}
          </span>
        )}
      </div>
      <ul className="flex min-w-[8.75rem] flex-1 flex-col gap-2">
        {segments.map((segment) => (
          <li
            key={segment.id}
            className="flex items-center gap-2.5 text-[0.8125rem] text-foreground"
          >
            <span
              aria-hidden="true"
              className={cx('size-2.5 flex-none rounded-[3px]', BAR_TONE[segment.tone])}
            />
            <span className="flex-1">{segment.label}</span>{' '}
            <span className="font-bold text-brand-ink tabular-nums">
              {formatValue(segment.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
