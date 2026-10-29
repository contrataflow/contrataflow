'use client';

import type { ComponentPropsWithRef, ReactNode } from 'react';

import { fieldControlProps, useFieldControl } from './field.js';
import { controlClassName } from '../lib/control-class.js';
import { cx } from '../lib/cx.js';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Ícone decorativo à esquerda (ex.: `<Search />` numa busca). */
  readonly icon?: ReactNode;
}

/** Campo de texto (shadcn/ui): 44 px, liga-se ao `Field` que o contém. */
export function Input({ className, icon, type = 'text', ...props }: InputProps) {
  const field = useFieldControl();
  const input = (
    <input
      type={type}
      {...props}
      {...fieldControlProps(field, props)}
      className={controlClassName(cx('min-h-11 py-2', icon ? 'pl-9' : undefined, className))}
    />
  );
  if (!icon) return input;
  return (
    <span className="relative flex w-full min-w-0 items-center">
      <span className="pointer-events-none absolute left-3 flex text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      {input}
    </span>
  );
}

export type TextareaProps = ComponentPropsWithRef<'textarea'>;

/** Área de texto (shadcn/ui): cresce com o conteúdo (`field-sizing`), sem rolagem própria até o limite. */
export function Textarea({ className, rows = 3, ...props }: TextareaProps) {
  const field = useFieldControl();
  return (
    <textarea
      rows={rows}
      {...props}
      {...fieldControlProps(field, props)}
      className={controlClassName(cx('[field-sizing:content] min-h-20 py-2.5', className))}
    />
  );
}
