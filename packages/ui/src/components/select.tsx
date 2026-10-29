'use client';

import { Select as SelectPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { Check, ChevronDown, ChevronUp } from '../icons.js';
import { fieldControlProps, useFieldControl } from './field.js';
import { controlClassName } from '../lib/control-class.js';
import { cx } from '../lib/cx.js';

/*
 * Seleção de uma opção (shadcn/ui sobre Radix Select), no lugar do `<select>` nativo: abre com
 * Enter, Espaço ou setas; setas, Home/End e digitação navegam; Enter escolhe; `Esc` fecha e
 * devolve o foco ao gatilho. O valor vazio não é opção (Radix): use `placeholder` no `SelectValue`.
 */

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Trigger>) {
  const field = useFieldControl();
  return (
    <SelectPrimitive.Trigger
      {...props}
      {...fieldControlProps(field, props)}
      className={controlClassName(
        cx(
          'min-h-11 items-center justify-between gap-2 py-2 text-left',
          'data-[placeholder]:text-muted-foreground [&>span]:truncate',
          className,
        ),
      )}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 flex-none text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 6,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        className={cx(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)',
          'overflow-hidden rounded-card bg-popover text-popover-foreground shadow-popover',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-7 items-center justify-center text-muted-foreground">
          <ChevronUp className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-7 items-center justify-center text-muted-foreground">
          <ChevronDown className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cx(
        'relative flex min-h-9 cursor-pointer items-center gap-2 rounded-control py-1.5 pr-8 pl-3 text-sm outline-none select-none',
        'data-[disabled]:cursor-not-allowed data-[disabled]:text-muted-foreground data-[highlighted]:bg-muted',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex text-primary">
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cx('px-3 py-1.5 text-label text-muted-foreground uppercase', className)}
      {...props}
    />
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cx('my-1 h-px bg-border', className)} {...props} />;
}
