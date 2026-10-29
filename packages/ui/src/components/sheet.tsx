'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { X } from '../icons.js';
import type { DialogContentProps } from './dialog.js';
import { cx } from '../lib/cx.js';

/*
 * Painel lateral (Sheet) sobre o Radix Dialog (prd-5 · kit): preso à direita em tela grande, em
 * tela cheia abaixo de 768 px; foco preso, `Esc` fecha e devolve o foco. Cabeçalho e rodapé fixos;
 * só o `SheetBody` rola (rolagem interna permitida em Dialog/Sheet — prd-5 · regra 8).
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends DialogContentProps {
  /** `default` (576 px) para formulários e detalhes; `wide` (896 px) para comparações e tabelas. */
  readonly size?: 'default' | 'wide' | undefined;
}

const SIZES = {
  default: 'md:max-w-xl',
  wide: 'md:max-w-4xl',
} as const;

export function SheetContent({
  className,
  children,
  closeLabel = 'Fechar',
  size = 'default',
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/45" />
      <DialogPrimitive.Content
        className={cx(
          'fixed inset-0 z-50 flex flex-col bg-surface text-foreground shadow-lg',
          'md:inset-y-0 md:right-0 md:left-auto md:w-full md:border-l md:border-border',
          SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        {closeLabel === null ? null : (
          <DialogPrimitive.Close
            className="absolute top-3 right-3 grid size-8 place-items-center rounded-control text-muted-foreground hover:bg-muted"
            aria-label={closeLabel}
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cx('flex flex-col gap-1 border-b border-border px-6 pt-5 pr-14 pb-4', className)}
      {...props}
    />
  );
}

export function SheetTitle({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cx('text-lg font-bold text-brand-ink', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cx('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Corpo rolável do painel (cresce entre o cabeçalho e o rodapé). */
export function SheetBody({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cx('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5', className)}
      {...props}
    />
  );
}

export function SheetFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cx(
        'flex flex-wrap justify-end gap-2 border-t border-border bg-surface px-6 py-4',
        className,
      )}
      {...props}
    />
  );
}
