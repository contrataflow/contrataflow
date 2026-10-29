'use client';

import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Interruptor (shadcn/ui sobre Radix Switch): `role="switch"`, Espaço/Enter alternam. Para
 * preferências que valem na hora; em formulários com "Salvar", prefira `Checkbox`.
 */
export function Switch({
  className,
  ...props
}: ComponentPropsWithRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cx(
        'peer inline-flex h-6 w-10 flex-none items-center rounded-full border-2 border-transparent transition-colors',
        'bg-muted-foreground data-[state=checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:bg-muted',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cx(
          'pointer-events-none block size-5 rounded-full bg-surface shadow-sm transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
