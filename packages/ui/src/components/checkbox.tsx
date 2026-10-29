'use client';

import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { Check, Minus } from '../icons.js';
import { cx } from '../lib/cx.js';

/*
 * Caixa de seleção (shadcn/ui sobre Radix Checkbox): `role="checkbox"`, Espaço alterna, estado
 * misto (`checked="indeterminate"`) para "selecionar todos". Quadrado de 20 px dentro de um alvo
 * de 24 px; o rótulo vem de um `<Label htmlFor>` ao lado (ou `aria-label`).
 */
export function Checkbox({
  className,
  ...props
}: ComponentPropsWithRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cx(
        'peer grid size-5 flex-none place-items-center rounded-[0.3125rem] border-2 border-muted-foreground bg-surface',
        'transition-colors hover:border-foreground',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        'disabled:cursor-not-allowed disabled:border-border disabled:bg-muted aria-invalid:border-destructive',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3.5" strokeWidth={3} />
        ) : (
          <Check className="size-3.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
