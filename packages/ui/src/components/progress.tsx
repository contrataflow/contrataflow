'use client';

import { Progress as ProgressPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';
import { BAR_TONE } from '../lib/tones.js';
import type { StatusTone } from '../lib/tones.js';

export interface ProgressProps extends ComponentPropsWithRef<typeof ProgressPrimitive.Root> {
  /** Cor da barra (azul por padrão). */
  readonly tone?: StatusTone | undefined;
}

/**
 * Barra de progresso (shadcn/ui sobre Radix Progress): `role="progressbar"` com `aria-valuenow`;
 * precisa de nome acessível (`aria-label` ou `aria-labelledby`). Sem `value`, fica indeterminada.
 */
export function Progress({ className, value, max = 100, tone = 'info', ...props }: ProgressProps) {
  const percent = value === null || value === undefined ? 0 : (value / max) * 100;
  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      className={cx('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cx('h-full rounded-full transition-[width]', BAR_TONE[tone])}
        style={{ width: `${String(Math.min(100, Math.max(0, percent)))}%` }}
      />
    </ProgressPrimitive.Root>
  );
}
