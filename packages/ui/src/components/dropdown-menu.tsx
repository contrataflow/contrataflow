'use client';

import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Menu suspenso (shadcn/ui sobre Radix DropdownMenu): `role="menu"`, setas/Home/End/digitação,
 * `Esc` fecha e devolve o foco ao gatilho (RN-FND-96).
 */

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cx(
          'z-50 min-w-56 rounded-card border border-border bg-surface p-1 text-foreground shadow-lg',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      className={cx(
        'flex min-h-9 cursor-pointer items-center gap-2 rounded-control px-3 text-sm outline-none select-none',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[highlighted]:bg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cx(
        'px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cx('my-1 h-px bg-border', className)} {...props} />;
}
