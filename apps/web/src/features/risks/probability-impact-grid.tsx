'use client';

import { cx } from '@contrataflow/ui';
import { RISK_LEVEL_LABELS, assessRisk } from '@contrataflow/validation';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { LEVEL_CLASSES } from './level-badge';
import { cellLabelOf, moveGridPosition } from './risks-model';
import type { GridPosition, LevelThresholdBand, RiskScale } from './risks-model';

export interface ProbabilityImpactGridProps {
  readonly id: string;
  /** Nome acessível da grade ("Avaliação de probabilidade e impacto"). */
  readonly label: string;
  readonly scale: RiskScale;
  readonly thresholds: readonly LevelThresholdBand[];
  readonly probability: number | null;
  readonly impact: number | null;
  readonly onChange: (probability: number, impact: number) => void;
  readonly disabled?: boolean | undefined;
  /** Texto do erro (V-03) ligado à grade por `aria-describedby`. */
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly probabilityAxisLabel: string;
  readonly impactAxisLabel: string;
}

/**
 * `ProbabilityImpactGrid` (US-033 · SCR-011): grade de probabilidade (linhas, maior no topo) ×
 * impacto (colunas) com os rótulos de `risk.scale`. Padrão WAI-ARIA `grid`: uma célula na ordem de
 * tabulação (roving tabindex), setas movem o foco (↑ probabilidade maior, → impacto maior), Home/End
 * vão às pontas da linha, Enter/Espaço (ou clique) selecionam. Cada célula tem `aria-label` com
 * rótulos, escore e nível; a cor do nível vem sempre com o texto.
 */
export function ProbabilityImpactGrid({
  id,
  label,
  scale,
  thresholds,
  probability,
  impact,
  onChange,
  disabled = false,
  error,
  required,
  probabilityAxisLabel,
  impactAxisLabel,
}: ProbabilityImpactGridProps) {
  const middle = Math.ceil(scale.max / 2);
  const selected: GridPosition | null =
    probability !== null &&
    impact !== null &&
    probability >= 1 &&
    probability <= scale.max &&
    impact >= 1 &&
    impact <= scale.max
      ? { probability, impact }
      : null;
  const [focus, setFocus] = useState<GridPosition | null>(null);
  const cells = useRef(new Map<string, HTMLDivElement>());
  const active = focus ?? selected ?? { probability: middle, impact: middle };
  const errorId = `${id}-error`;
  const keyOf = (p: number, i: number) => `${String(p)}:${String(i)}`;
  const probabilities = Array.from({ length: scale.max }, (_, index) => scale.max - index);
  const impacts = Array.from({ length: scale.max }, (_, index) => index + 1);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, position: GridPosition) => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onChange(position.probability, position.impact);
      return;
    }
    const next = moveGridPosition(position, event.key, scale.max);
    if (next === null) return;
    event.preventDefault();
    setFocus(next);
    cells.current.get(keyOf(next.probability, next.impact))?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
        {required ? ' *' : ''}
      </span>
      <div className="overflow-x-auto">
        <div
          role="grid"
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={error ? errorId : undefined}
          data-invalid={error ? true : undefined}
          aria-readonly={disabled ? true : undefined}
          className="grid min-w-[20rem] gap-1"
          style={{
            gridTemplateColumns: `minmax(4.5rem, 7rem) repeat(${String(scale.max)}, minmax(3.25rem, 1fr))`,
          }}
        >
          <div role="row" className="contents">
            <div role="columnheader" className="p-1 text-xs text-muted-foreground">
              <span className="sr-only">
                {probabilityAxisLabel} / {impactAxisLabel}
              </span>
            </div>
            {impacts.map((value) => (
              <div
                key={value}
                role="columnheader"
                className="p-1 text-center text-xs font-medium break-words text-muted-foreground"
              >
                <span className="sr-only">{impactAxisLabel} </span>
                {scale.impactLabels[value - 1] ?? ''} ({value})
              </div>
            ))}
          </div>
          {probabilities.map((p) => (
            <div key={p} role="row" className="contents">
              <div
                role="rowheader"
                className="flex items-center p-1 text-xs font-medium break-words text-muted-foreground"
              >
                <span className="sr-only">{probabilityAxisLabel} </span>
                {scale.probabilityLabels[p - 1] ?? ''} ({p})
              </div>
              {impacts.map((i) => {
                const { score, level } = assessRisk(p, i, thresholds);
                const isSelected = selected?.probability === p && selected.impact === i;
                const isActive = active.probability === p && active.impact === i;
                return (
                  <div
                    key={i}
                    role="gridcell"
                    ref={(element) => {
                      if (element) cells.current.set(keyOf(p, i), element);
                      else cells.current.delete(keyOf(p, i));
                    }}
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isSelected}
                    aria-disabled={disabled ? true : undefined}
                    aria-label={cellLabelOf(p, i, scale, thresholds)}
                    className={cx(
                      'flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-control border-2 px-1 text-center select-none',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      LEVEL_CLASSES[level],
                      isSelected && 'ring-2 ring-foreground ring-offset-2',
                      disabled && 'cursor-not-allowed opacity-60',
                    )}
                    onFocus={() => {
                      setFocus({ probability: p, impact: i });
                    }}
                    onClick={() => {
                      if (disabled) return;
                      setFocus({ probability: p, impact: i });
                      onChange(p, i);
                    }}
                    onKeyDown={(event) => {
                      onKeyDown(event, { probability: p, impact: i });
                    }}
                  >
                    <span aria-hidden="true" className="text-sm font-semibold">
                      {isSelected ? '✓ ' : ''}
                      {score}
                    </span>
                    <span aria-hidden="true" className="text-[0.65rem] leading-tight">
                      {RISK_LEVEL_LABELS[level]}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
