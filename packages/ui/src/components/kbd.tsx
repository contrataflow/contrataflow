import type { ComponentPropsWithoutRef } from 'react';

import { cx } from '../lib/cx.js';

export type KbdProps = ComponentPropsWithoutRef<'kbd'>;

/** Tecla ou atalho de teclado (ex.: "Ctrl K" na busca global). */
export function Kbd({ className, ...props }: KbdProps) {
  return (
    <kbd
      className={cx(
        'inline-flex items-center rounded-md border border-border-strong bg-surface px-1.5 py-0.5 font-sans text-[0.6875rem] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
