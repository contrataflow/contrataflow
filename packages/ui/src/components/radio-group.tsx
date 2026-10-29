'use client';

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { useFieldControl } from './field.js';
import { cx } from '../lib/cx.js';

/*
 * Grupo de opções exclusivas (shadcn/ui sobre Radix RadioGroup): setas movem e escolhem, Tab entra
 * e sai do grupo. Dentro de um `Field group`, herda a ajuda e o erro do `fieldset`.
 */
export function RadioGroup({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadioGroupPrimitive.Root>) {
  const field = useFieldControl();
  return (
    <RadioGroupPrimitive.Root
      aria-invalid={field?.invalid ? true : undefined}
      aria-required={field?.required ? true : undefined}
      className={cx('flex flex-col gap-2.5', className)}
      {...props}
    />
  );
}

export function RadioGroupItem({
  className,
  ...props
}: ComponentPropsWithRef<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cx(
        'peer grid size-5 flex-none place-items-center rounded-full border-2 border-muted-foreground bg-surface',
        'transition-colors hover:border-foreground data-[state=checked]:border-primary',
        'disabled:cursor-not-allowed disabled:border-border disabled:bg-muted',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-primary" />
    </RadioGroupPrimitive.Item>
  );
}
