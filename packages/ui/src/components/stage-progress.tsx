import type { ReactNode } from 'react';

import { Check } from '../icons.js';
import { cx } from '../lib/cx.js';
import { SOFT_TONE } from '../lib/tones.js';
import type { StatusTone } from '../lib/tones.js';

export interface StageProgressStep {
  readonly id: string;
  readonly label: ReactNode;
  /** Detalhe mostrado só quando a etapa é a atual (responsável, prazo…). */
  readonly detail?: ReactNode;
}

export interface StageProgressLabels {
  readonly done: string;
  readonly current: string;
  readonly upcoming: string;
  /** "Etapa 3 de 7". */
  readonly position: (current: number, total: number) => string;
}

export const STAGE_PROGRESS_LABELS: StageProgressLabels = {
  done: 'concluída',
  current: 'etapa atual',
  upcoming: 'pendente',
  position: (current, total) => `Etapa ${String(current)} de ${String(total)}`,
};

export interface StageProgressProps {
  readonly steps: readonly StageProgressStep[];
  /** Índice da etapa atual (0…n-1); `steps.length` quando todas terminaram. */
  readonly current: number;
  /** Nome acessível da trilha (ex.: "Etapas do processo"). */
  readonly label: string;
  /** Tom do destaque da etapa atual (ex.: `warning` com prazo vencendo). */
  readonly currentTone?: StatusTone | undefined;
  readonly labels?: Partial<StageProgressLabels> | undefined;
  readonly className?: string | undefined;
}

const DOT_RING: Record<StatusTone, string> = {
  info: 'border-primary',
  success: 'border-success',
  warning: 'border-warning',
  danger: 'border-destructive',
  approval: 'border-approval',
  neutral: 'border-neutral',
};

/**
 * Etapas como barra fina de pontos ligados (prd-5 · regra 6): concluídas em azul com ✓, a atual
 * com anel e o detalhe abaixo da barra, as pendentes em cinza. Lista ordenada com
 * `aria-current="step"`; quebra linha em vez de rolar (prd-5 · regra 8).
 */
export function StageProgress({
  steps,
  current,
  label,
  currentTone = 'info',
  labels,
  className,
}: StageProgressProps) {
  const text = { ...STAGE_PROGRESS_LABELS, ...labels };
  const active = steps[current];

  return (
    <nav aria-label={label} className={cx('flex flex-col gap-3', className)}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
        {steps.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'upcoming';
          const last = index === steps.length - 1;
          return (
            <li
              key={step.id}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex min-w-0 flex-[1_1_auto] items-center gap-2"
            >
              <span
                aria-hidden="true"
                className={cx(
                  'grid size-4 flex-none place-items-center rounded-full',
                  state === 'done' && 'bg-primary text-primary-foreground',
                  state === 'current' && cx('border-[3px] bg-surface', DOT_RING[currentTone]),
                  state === 'upcoming' && 'border-2 border-border-strong bg-surface',
                )}
              >
                {state === 'done' ? <Check className="size-2.5" strokeWidth={4} /> : null}
              </span>
              <span
                className={cx(
                  'text-[0.8125rem] whitespace-nowrap',
                  state === 'current' && 'font-bold text-brand-ink',
                  state === 'done' && 'font-medium text-foreground',
                  state === 'upcoming' && 'text-muted-foreground',
                )}
              >
                {step.label}
                <span className="sr-only">
                  {' '}
                  (
                  {state === 'done'
                    ? text.done
                    : state === 'current'
                      ? text.current
                      : text.upcoming}
                  )
                </span>
              </span>
              {last ? null : (
                <span
                  aria-hidden="true"
                  className={cx(
                    'h-0.5 min-w-4 flex-1 rounded-full',
                    index < current ? 'bg-primary' : 'bg-border',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      {active ? (
        <div
          className={cx(
            'flex flex-wrap items-baseline gap-x-2 gap-y-1 self-start rounded-control px-3 py-2 text-sm',
            SOFT_TONE[currentTone],
          )}
        >
          <span className="font-bold">{text.position(current + 1, steps.length)}</span>
          {active.detail ? <span>{active.detail}</span> : null}
        </div>
      ) : null}
    </nav>
  );
}
