'use client';

import { Separator as SeparatorPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';

/** Divisor (shadcn/ui sobre Radix Separator): decorativo por padrão; `decorative={false}` anuncia. */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: ComponentPropsWithRef<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cx(
        'flex-none bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className,
      )}
      {...props}
    />
  );
}
