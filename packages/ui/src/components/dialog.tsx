'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

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
          'fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4',
          'rounded-card border border-border bg-surface p-6 text-foreground shadow-lg',
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
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * Painel lateral (Sheet) sobre o mesmo Radix Dialog: preso à direita em tela grande, em tela cheia
 * abaixo de 768 px; rolagem própria e rodapé fixo por conta de quem usa (`flex` em coluna).
 */
export function SheetContent({
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
          'fixed inset-0 z-50 flex flex-col bg-surface text-foreground shadow-lg',
          'md:inset-y-0 md:right-0 md:left-auto md:w-full md:max-w-xl md:border-l md:border-border',
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
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </DialogPrimitive.Close>
        )}
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
