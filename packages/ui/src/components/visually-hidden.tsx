import type { ComponentPropsWithoutRef } from 'react';

import { cx } from '../lib/cx.js';

export type VisuallyHiddenProps = ComponentPropsWithoutRef<'span'>;

/** Conteúdo lido por tecnologias assistivas e oculto visualmente (WCAG 2.2 — 1.3.1). */
export function VisuallyHidden({ className, ...props }: VisuallyHiddenProps) {
  return <span {...props} className={cx('sr-only', className)} />;
}
