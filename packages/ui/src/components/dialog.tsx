'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { X } from '../icons.js';
import { cx } from '../lib/cx.js';

/*
 * Diálogo modal (shadcn/ui sobre Radix Dialog): foco preso, `Esc` fecha, foco devolvido ao
 * elemento que abriu (RN-FND-96). Título obrigatório para leitores de tela.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentPropsWithRef<typeof DialogPrimitive.Content> {
  /** Rótulo acessível do botão de fechar no canto; `null` omite o botão. */
  readonly closeLabel?: string | null | undefined;
}

export function DialogContent({
  className,
  children,
  closeLabel = 'Fechar',
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/45" />
      <DialogPrimitive.Content
        className={cx(
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 content-start gap-4',
          'rounded-card bg-surface p-6 text-foreground shadow-popover',
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

/**
 * Folha inferior (bottom sheet) sobre o mesmo Radix Dialog: presa à base da tela, largura total e
 * rolagem própria — para menus de ação em telas pequenas (< 768 px).
 */
export function BottomSheetContent({
  className,
  children,
  closeLabel: _closeLabel,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/45" />
      <DialogPrimitive.Content
        className={cx(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col gap-2 overflow-y-auto',
          'rounded-t-card border-t border-border bg-surface p-4 text-foreground shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cx('pr-8 text-lg font-semibold', className)} {...props} />
  );
}

export function DialogDescription({
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

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cx('flex flex-wrap justify-end gap-2', className)} {...props} />;
}
