import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

export type AlertTone = 'info' | 'warning' | 'error' | 'success';

const TONES: Record<AlertTone, string> = {
  info: 'border-primary/30 bg-primary-soft',
  warning: 'border-warning/30 bg-warning-soft',
  error: 'border-destructive/30 bg-destructive-soft',
  success: 'border-success/30 bg-success-soft',
};

export interface AlertProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  readonly tone?: AlertTone | undefined;
  readonly title: ReactNode;
  /**
   * `true` (padrão) anuncia o conteúdo: `role="alert"` para erro, `role="status"` para os demais.
   * `false` para mensagens estáticas que não devem interromper o leitor de tela.
   */
  readonly live?: boolean | undefined;
}

/** Mensagem em linha. O tom nunca é a única informação: o título sempre descreve o estado. */
export function Alert({
  tone = 'info',
  title,
  live = true,
  className,
  children,
  ...props
}: AlertProps) {
  const role = live ? (tone === 'error' ? 'alert' : 'status') : undefined;
  return (
    <div
      role={role}
      className={cx('rounded-card border p-4 text-sm text-foreground', TONES[tone], className)}
      {...props}
    >
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
