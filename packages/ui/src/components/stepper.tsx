import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

export interface StepperStep {
  /** Identificador estável do passo. */
  readonly id: string;
  readonly label: ReactNode;
}

export interface StepperProps extends Omit<ComponentPropsWithoutRef<'nav'>, 'children'> {
  readonly steps: readonly StepperStep[];
  /** Índice (base 0) do passo atual. */
  readonly current: number;
  /**
   * Torna os passos já concluídos navegáveis (botões, alcançáveis por Tab). Sem ele, o indicador é
   * só informativo.
   */
  readonly onStepSelect?: ((index: number) => void) | undefined;
  /** Rótulo acessível da lista (ex.: "Passos para criar o processo"). */
  readonly label: string;
  /**
   * Indicador compacto exibido abaixo de 768 px, no lugar da lista (padrão: "Passo 2 de 3").
   */
  readonly progressLabel?: string | undefined;
  /** Texto lido após o rótulo de um passo concluído (padrão: "concluído"). */
  readonly completeLabel?: string | undefined;
}

/**
 * Indicador de passos de um fluxo em etapas (wizard). Lista ordenada com `aria-current="step"` no
 * passo atual; o estado nunca depende só da cor (número, marca de concluído e texto oculto). Passos
 * concluídos podem ser reabertos pelo teclado. Abaixo de 768 px vira "Passo 2 de 3".
 */
export function Stepper({
  steps,
  current,
  onStepSelect,
  label,
  progressLabel,
  completeLabel = 'concluído',
  className,
  ...props
}: StepperProps) {
  const compact = progressLabel ?? `Passo ${String(current + 1)} de ${String(steps.length)}`;
  return (
    <nav aria-label={label} className={cx('w-full', className)} {...props}>
      <p className="text-sm font-medium text-muted-foreground md:hidden">{compact}</p>
      <ol className="hidden items-center gap-2 md:flex">
        {steps.map((step, index) => {
          const state = index < current ? 'complete' : index === current ? 'current' : 'upcoming';
          const marker = (
            <span
              aria-hidden="true"
              className={cx(
                'grid size-7 flex-none place-items-center rounded-full border text-sm font-semibold',
                state === 'upcoming' && 'border-border bg-surface text-muted-foreground',
                state === 'current' && 'border-primary bg-primary text-primary-foreground',
                state === 'complete' && 'border-primary bg-primary-soft text-primary',
              )}
            >
              {state === 'complete' ? '✓' : index + 1}
            </span>
          );
          const text = (
            <>
              <span
                className={cx(
                  'text-sm',
                  state === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
              {state === 'complete' ? <span className="sr-only">({completeLabel})</span> : null}
            </>
          );
          return (
            <li
              key={step.id}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              {state === 'complete' && onStepSelect ? (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-control p-1 hover:bg-muted"
                  onClick={() => {
                    onStepSelect(index);
                  }}
                >
                  {marker}
                  {text}
                </button>
              ) : (
                <span className="flex items-center gap-2 p-1">
                  {marker}
                  {text}
                </span>
              )}
              {index < steps.length - 1 ? (
                <span aria-hidden="true" className="h-px w-8 flex-none bg-border" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
