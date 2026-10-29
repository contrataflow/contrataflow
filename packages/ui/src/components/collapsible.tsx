'use client';

import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { ChevronDown } from '../icons.js';
import { cx } from '../lib/cx.js';

/*
 * Bloco recolhível (shadcn/ui sobre Radix Collapsible): o "Ver mais" da informação secundária
 * (prd-5 · regra 7). O gatilho é um botão com `aria-expanded` e `aria-controls`.
 */

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleContent = CollapsiblePrimitive.Content;

export interface CollapsibleTriggerProps extends ComponentPropsWithRef<
  typeof CollapsiblePrimitive.Trigger
> {
  /** Sem a seta (quando o filho já é um botão com ícone próprio). */
  readonly hideChevron?: boolean | undefined;
}

export function CollapsibleTrigger({
  className,
  children,
  hideChevron = false,
  asChild,
  ...props
}: CollapsibleTriggerProps) {
  if (asChild)
    return (
      <CollapsiblePrimitive.Trigger asChild {...props}>
        {children}
      </CollapsiblePrimitive.Trigger>
    );
  return (
    <CollapsiblePrimitive.Trigger
      className={cx(
        'group inline-flex min-h-9 items-center gap-1.5 rounded-control text-sm font-semibold text-primary hover:text-primary-hover',
        className,
      )}
      {...props}
    >
      {children}
      {hideChevron ? null : (
        <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      )}
    </CollapsiblePrimitive.Trigger>
  );
}
