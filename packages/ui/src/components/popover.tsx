'use client';

import { Popover as PopoverPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Popover (shadcn/ui sobre Radix Popover): painel flutuante não modal ancorado no gatilho (filtros,
 * seletor de data, combobox). `Esc` e clique fora fecham; o foco volta ao gatilho.
 */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  collisionPadding = 16,
  ...props
}: ComponentPropsWithRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cx(
          'z-50 w-72 max-w-[calc(100vw-2rem)] rounded-card bg-popover p-4 text-popover-foreground shadow-popover outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
