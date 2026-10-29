'use client';

import { Command as CommandPrimitive, useCommandState } from 'cmdk';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { Search } from '../icons.js';
import { VisuallyHidden } from './visually-hidden.js';
import { cx } from '../lib/cx.js';

/*
 * Lista de comandos com busca (shadcn/ui sobre `cmdk`): a base da paleta Ctrl K (`CommandDialog`)
 * e do `Combobox`. A busca filtra enquanto digita; setas (com volta), Home/End e Enter escolhem;
 * `CommandEmpty` aparece quando nada casa. Rolagem só dentro da lista (painel flutuante).
 */

export function Command({
  className,
  loop = true,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      loop={loop}
      className={cx(
        'flex w-full flex-col overflow-hidden rounded-card bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3" cmdk-input-wrapper="">
      <Search className="size-4 flex-none text-muted-foreground" />
      <CommandPrimitive.Input
        className={cx(
          'flex min-h-11 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground',
          'disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({
  className,
  label = 'Sugestões',
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      label={label}
      className={cx('max-h-80 overflow-x-hidden overflow-y-auto p-1', className)}
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cx('px-3 py-6 text-center text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cx(
        'overflow-hidden p-1 text-foreground',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label',
        '[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Divisor entre grupos, escondido durante a busca. Próprio, não o do cmdk: o `role="separator"`
 * dele dentro do `listbox` reprova no axe (`aria-required-children`); este é só visual.
 */
export function CommandSeparator({ className, ...props }: ComponentPropsWithRef<'div'>) {
  const searching = useCommandState((state) => state.search !== '');
  if (searching) return null;
  return <div aria-hidden="true" className={cx('-mx-1 h-px bg-border', className)} {...props} />;
}

export function CommandItem({
  className,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cx(
        'relative flex min-h-10 cursor-pointer items-center gap-2.5 rounded-control px-2.5 text-sm outline-none select-none',
        'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:text-muted-foreground',
        'data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:flex-none',
        className,
      )}
      {...props}
    />
  );
}

/** Atalho à direita do item (ex.: "G P"); decorativo — o atalho real é registrado pelo app. */
export function CommandShortcut({ className, ...props }: ComponentPropsWithRef<'span'>) {
  return (
    <span
      className={cx('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export interface CommandDialogProps extends Omit<
  ComponentPropsWithRef<typeof DialogPrimitive.Root>,
  'children'
> {
  /** Título do diálogo para leitores de tela (ex.: "Paleta de comandos"). */
  readonly title: string;
  readonly description?: string | undefined;
  /** Nome acessível da lista (cmdk `label`). */
  readonly label?: string | undefined;
  /** Filtro próprio (ex.: busca no servidor): `false` desliga o filtro do cmdk. */
  readonly shouldFilter?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/** Paleta de comandos (Ctrl K) num diálogo modal, no topo da tela. */
export function CommandDialog({
  title,
  description,
  label,
  shouldFilter,
  className,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/45" />
        <DialogPrimitive.Content
          className={cx(
            'fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2',
            'overflow-hidden rounded-card bg-popover shadow-popover',
            className,
          )}
          // Sem descrição, desliga o aviso do Radix; com ela, o Radix liga o `aria-describedby`.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <VisuallyHidden>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
            ) : null}
          </VisuallyHidden>
          <Command label={label ?? title} shouldFilter={shouldFilter ?? true}>
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
