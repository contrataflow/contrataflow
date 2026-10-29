import { useId } from 'react';
import type { ReactNode } from 'react';

import { Check } from '../icons.js';
import { StageProgress } from './stage-progress.js';
import type { StageProgressLabels, StageProgressStep } from './stage-progress.js';
import { cx } from '../lib/cx.js';

export interface FormSectionProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/** Seção de formulário: cartão com título (16/700), texto de apoio e os campos empilhados. */
export function FormSection({ title, description, children, className }: FormSectionProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cx('flex flex-col gap-5 rounded-card bg-surface p-6 shadow-card', className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-section-title text-brand-ink">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Barra de ações do formulário, fixa no rodapé da janela enquanto o formulário rola (sticky, sem
 * rolagem própria): secundárias à esquerda, a primária por último.
 */
export function FormActionBar({
  children,
  status,
  label,
  className,
}: {
  readonly children: ReactNode;
  /** À esquerda: estado do salvamento automático (`AutosaveIndicator`). */
  readonly status?: ReactNode;
  /** Nome da região (leitor de tela). */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cx(
        'sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2.5 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-card sm:border-0 sm:shadow-popover',
        className,
      )}
    >
      {status ? <div className="mr-auto min-w-0 text-sm">{status}</div> : null}
      {children}
    </div>
  );
}

export interface FormPageProps {
  /** Cabeçalho (`PageHeader`). */
  readonly header: ReactNode;
  /** Avisos acima das seções (ex.: `RecoveredDraftBanner`). */
  readonly notices?: ReactNode;
  /** Seções (`FormSection`). */
  readonly children: ReactNode;
  /** Botões da barra fixa no rodapé (Salvar rascunho · Continuar). */
  readonly actions?: ReactNode;
  /** Estado do salvamento automático, à esquerda da barra (`AutosaveIndicator`). */
  readonly autosave?: ReactNode;
  readonly actionsLabel?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Modelo de página de formulário (prd-5 · §2): coluna única de 720 px, seções com título e a barra
 * de ações fixa no rodapé.
 */
export function FormPage({
  header,
  notices,
  children,
  actions,
  autosave,
  actionsLabel,
  className,
}: FormPageProps) {
  return (
    <div className={cx('mx-auto flex w-full max-w-[45rem] min-w-0 flex-col gap-5', className)}>
      {header}
      {notices}
      {children}
      {actions || autosave ? (
        <FormActionBar status={autosave} label={actionsLabel}>
          {actions}
        </FormActionBar>
      ) : null}
    </div>
  );
}

export interface WizardShellProps extends Omit<FormPageProps, 'header'> {
  readonly header: ReactNode;
  readonly steps: readonly StageProgressStep[];
  /** Índice do passo atual. */
  readonly current: number;
  /** Nome acessível da lista de passos. */
  readonly stepsLabel: string;
  /** Volta a um passo já feito (os passos futuros não são clicáveis). */
  readonly onStepSelect?: ((index: number) => void) | undefined;
  readonly stepLabels?: Partial<StageProgressLabels> | undefined;
}

/**
 * Assistente em passos (prd-5 · §2): os passos ficam à esquerda em telas largas (lista ordenada,
 * concluídos com ✓ e clicáveis) e viram a barra `StageProgress` em telas estreitas; o formulário
 * segue o `FormPage` (720 px, barra de ações fixa, salvamento automático e rascunho recuperado).
 */
export function WizardShell({
  header,
  steps,
  current,
  stepsLabel,
  onStepSelect,
  stepLabels,
  notices,
  children,
  actions,
  autosave,
  actionsLabel,
  className,
}: WizardShellProps) {
  return (
    <div className={cx('mx-auto flex w-full max-w-[64rem] min-w-0 flex-col gap-5', className)}>
      {header}
      <StageProgress
        steps={steps}
        current={current}
        label={stepsLabel}
        labels={stepLabels}
        className="lg:hidden"
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,45rem)]">
        <nav aria-label={stepsLabel} className="hidden lg:block">
          <ol className="sticky top-24 flex flex-col gap-1">
            {steps.map((step, index) => {
              const done = index < current;
              const active = index === current;
              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className={cx(
                      'grid size-6 flex-none place-items-center rounded-full text-xs font-bold',
                      done && 'bg-primary text-primary-foreground',
                      active && 'border-2 border-primary bg-surface text-primary',
                      !done && !active && 'border-2 border-border-strong text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="size-3.5" strokeWidth={3} /> : index + 1}
                  </span>
                  <span className="min-w-0">{step.label}</span>
                </>
              );
              const row = cx(
                'flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-sm',
                active ? 'bg-primary-soft font-bold text-primary-soft-foreground' : 'font-medium',
                !done && !active && 'text-muted-foreground',
              );
              return (
                <li key={step.id} aria-current={active ? 'step' : undefined}>
                  {done && onStepSelect ? (
                    <button
                      type="button"
                      className={cx(row, 'hover:bg-muted')}
                      onClick={() => {
                        onStepSelect(index);
                      }}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={row}>{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="flex min-w-0 flex-col gap-5">
          {notices}
          {children}
          {actions || autosave ? (
            <FormActionBar status={autosave} label={actionsLabel}>
              {actions}
            </FormActionBar>
          ) : null}
        </div>
      </div>
    </div>
  );
}
