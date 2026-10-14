import type { ComponentPropsWithoutRef } from 'react';

import { cx } from '../lib/cx.js';

export interface SkipLinkProps extends ComponentPropsWithoutRef<'a'> {
  /** `id` do conteúdo principal (sem `#`). */
  readonly targetId: string;
}

/** "Pular para o conteúdo" (eMAG 3.1 — 1.5): invisível até receber foco pelo teclado. */
export function SkipLink({
  targetId,
  className,
  children = 'Pular para o conteúdo',
  ...props
}: SkipLinkProps) {
  return (
    <a
      href={`#${targetId}`}
      className={cx(
        'fixed top-2 left-2 z-[100] -translate-y-24 rounded-control bg-surface px-3 py-2 text-sm font-medium text-foreground shadow',
        'focus:translate-y-0',
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}
