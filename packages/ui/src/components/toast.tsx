'use client';

import { Toast as ToastPrimitive } from 'radix-ui';
import { useSyncExternalStore } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Toasts (shadcn/ui sobre Radix Toast): região `aria-live` (RN-FND-96), pausa ao focar/passar o
 * mouse, `F8` leva o foco à região. Disparo imperativo por `toast()` de qualquer folha cliente.
 */

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly tone?: ToastTone | undefined;
}

export interface ToastMessage {
  readonly id: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly tone: ToastTone;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let messages: readonly ToastMessage[] = [];
let sequence = 0;

function emit(next: readonly ToastMessage[]): void {
  messages = next;
  for (const listener of listeners) listener();
}

/** Exibe um toast; devolve o id para fechá-lo antes do tempo. */
export function toast({ title, description, tone = 'info' }: ToastInput): string {
  sequence += 1;
  const id = `toast-${sequence}`;
  emit([...messages, { id, title, description, tone }]);
  return id;
}

export function dismissToast(id: string): void {
  emit(messages.filter((message) => message.id !== id));
}

/** Remove todos os toasts (ex.: troca de tenant ou logout). */
export function clearToasts(): void {
  emit([]);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const EMPTY: readonly ToastMessage[] = [];

const TONES: Record<ToastTone, string> = {
  info: 'border-border',
  success: 'border-success/40',
  error: 'border-destructive/40',
};

export interface ToasterProps {
  /** Rótulo da região; `{hotkey}` é substituído pelo atalho (F8). */
  readonly label?: string | undefined;
  readonly closeLabel?: string | undefined;
  /** Tempo de exibição em ms. */
  readonly duration?: number | undefined;
}

/** Região de toasts; montada uma vez no shell. */
export function Toaster({
  label = 'Notificações ({hotkey})',
  closeLabel = 'Fechar',
  duration = 6000,
}: ToasterProps) {
  const current = useSyncExternalStore(
    subscribe,
    () => messages,
    () => EMPTY,
  );
  return (
    <ToastPrimitive.Provider duration={duration} label="Notificação" swipeDirection="right">
      {current.map((message) => (
        <ToastPrimitive.Root
          key={message.id}
          type={message.tone === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => {
            if (!open) dismissToast(message.id);
          }}
          className={cx(
            'relative grid gap-1 rounded-card border bg-surface p-4 pr-10 text-sm text-foreground shadow-lg',
            TONES[message.tone],
          )}
        >
          <ToastPrimitive.Title className="font-semibold">{message.title}</ToastPrimitive.Title>
          {message.description ? (
            <ToastPrimitive.Description className="text-muted-foreground">
              {message.description}
            </ToastPrimitive.Description>
          ) : null}
          <ToastPrimitive.Close
            aria-label={closeLabel}
            className="absolute top-2 right-2 grid size-7 place-items-center rounded-control text-muted-foreground hover:bg-muted"
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
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        label={label}
        className="fixed right-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none"
      />
    </ToastPrimitive.Provider>
  );
}
