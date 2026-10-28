import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { SOFT_TONE } from '../lib/tones.js';
import type { StatusTone } from '../lib/tones.js';

export interface StatusChipProps extends ComponentPropsWithoutRef<'span'> {
  readonly tone?: StatusTone | undefined;
  /** Texto da situação — obrigatório: a cor nunca é a única informação. */
  readonly children: ReactNode;
}

/**
 * Chip de situação (prd-4 · padrão 7): fundo suave do tom e texto escuro do mesmo tom, contraste
 * ≥ 4,5:1 nos dois temas.
 */
export function StatusChip({ tone = 'neutral', className, children, ...props }: StatusChipProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        SOFT_TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
