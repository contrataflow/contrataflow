'use client';

import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { Info } from '../icons.js';
import { cx } from '../lib/cx.js';

/*
 * Dica (shadcn/ui sobre Radix Tooltip): aparece no foco e no hover, some com `Esc`; o texto vira a
 * descrição acessível do gatilho. Nunca guarda informação essencial nem ações (prd-5 · regra 7:
 * ajuda em ícone com tooltip). Cada `Tooltip` traz o próprio provider; `TooltipProvider` no topo
 * só ajusta o atraso de todos.
 */

export function TooltipProvider({
  delayDuration = 200,
  ...props
}: ComponentPropsWithRef<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

export function Tooltip(props: ComponentPropsWithRef<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root {...props} />
    </TooltipProvider>
  );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentPropsWithRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cx(
          'z-50 max-w-xs rounded-control bg-inverse px-3 py-1.5 text-[0.8125rem] text-inverse-foreground shadow-popover',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-inverse" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export interface InfoTooltipProps {
  /** Texto de ajuda. */
  readonly children: ReactNode;
  /** Nome acessível do botão (ex.: "Ajuda sobre o valor estimado"). */
  readonly label: string;
  readonly side?: 'top' | 'right' | 'bottom' | 'left' | undefined;
  readonly className?: string | undefined;
}

/** Ícone "i" com a ajuda em tooltip, ao lado de rótulos e títulos (prd-5 · regra 7). */
export function InfoTooltip({ children, label, side = 'top', className }: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cx(
            'inline-grid size-6 place-items-center rounded-full text-muted-foreground hover:text-foreground',
            className,
          )}
        >
          <Info className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{children}</TooltipContent>
    </Tooltip>
  );
}
