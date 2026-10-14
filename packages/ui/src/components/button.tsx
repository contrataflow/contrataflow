'use client';

import { Slot } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { buttonClassName } from '../lib/button-class.js';
import type { ButtonSize, ButtonVariant } from '../lib/button-class.js';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  /** Renderiza o filho (ex.: um link) com a aparência de botão (Radix `Slot`). */
  readonly asChild?: boolean | undefined;
}

/** Botão do design system (shadcn/ui + Radix `Slot`). `type="button"` por padrão. */
export function Button({ variant, size, asChild = false, className, ...props }: ButtonProps) {
  const classes = buttonClassName({ variant, size, className });
  if (asChild) return <Slot.Root className={classes} {...props} />;
  return <button type="button" className={classes} {...props} />;
}
