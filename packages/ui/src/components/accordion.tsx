'use client';

import { Accordion as AccordionPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { ChevronDown } from '../icons.js';
import { cx } from '../lib/cx.js';

/*
 * Acordeão (shadcn/ui sobre Radix Accordion): seções empilhadas que abrem uma a uma (`single`) ou
 * várias (`multiple`). Cada gatilho fica num título (`h3` por padrão) com `aria-expanded`; setas,
 * Home e End passam entre os gatilhos.
 */

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({
  className,
  ...props
}: ComponentPropsWithRef<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cx('border-b border-border last:border-b-0', className)}
      {...props}
    />
  );
}

export interface AccordionTriggerProps extends ComponentPropsWithRef<
  typeof AccordionPrimitive.Trigger
> {
  /** Nível do título que envolve o gatilho. */
  readonly headingLevel?: 2 | 3 | 4 | undefined;
}

export function AccordionTrigger({
  className,
  children,
  headingLevel = 3,
  ...props
}: AccordionTriggerProps) {
  const Heading = `h${String(headingLevel)}` as 'h2' | 'h3' | 'h4';
  return (
    <AccordionPrimitive.Header asChild>
      <Heading className="flex">
        <AccordionPrimitive.Trigger
          className={cx(
            'group flex min-h-12 flex-1 items-center justify-between gap-3 py-3 text-left text-sm font-semibold text-brand-ink',
            'hover:text-primary-hover',
            className,
          )}
          {...props}
        >
          {children}
          <ChevronDown className="size-4 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </AccordionPrimitive.Trigger>
      </Heading>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content className="text-sm" {...props}>
      <div className={cx('pb-4', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
