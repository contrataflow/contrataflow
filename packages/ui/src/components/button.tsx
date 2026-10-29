'use client';

import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { buttonClassName } from '../lib/button-class.js';
import type { ButtonSize, ButtonVariant } from '../lib/button-class.js';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  /** Renderiza o filho (ex.: um link) com a aparência de botão (Radix `Slot`). */
  readonly asChild?: boolean | undefined;
  /** Ícone antes do texto (ex.: `<Plus />` de `icons`); decorativo. */
  readonly iconLeft?: ReactNode;
  /** Ícone depois do texto (ex.: `<ChevronDown />`); decorativo. */
  readonly iconRight?: ReactNode;
}

/** Botão do design system (shadcn/ui + Radix `Slot`). `type="button"` por padrão. */
export function Button({
  variant,
  size,
  asChild = false,
  iconLeft,
  iconRight,
  className,
  children,
  ...props
}: ButtonProps) {
  const classes = buttonClassName({ variant, size, className });
  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {iconLeft}
        <Slot.Slottable>{children}</Slot.Slottable>
        {iconRight}
      </Slot.Root>
    );
  }
  return (
    <button type="button" className={classes} {...props}>
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
