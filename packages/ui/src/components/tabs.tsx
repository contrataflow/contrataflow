'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Abas (shadcn/ui sobre Radix Tabs): `tablist`/`tab`/`tabpanel`, setas, Home/End, ativação
 * automática. A lista quebra linha em vez de rolar (prd-5 · regra 8: só a página rola).
 */

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cx('flex flex-wrap gap-1 border-b border-border', className)}
      {...props}
    />
  );
}

const TAB_CLASS =
  'inline-flex min-h-11 items-center gap-2 px-3.5 text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed';

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cx(
        TAB_CLASS,
        'data-[state=inactive]:font-medium data-[state=inactive]:text-muted-foreground data-[state=inactive]:hover:text-foreground',
        'data-[state=active]:font-bold data-[state=active]:text-primary-soft-foreground',
        'data-[state=active]:shadow-[inset_0_-2px_0_var(--color-primary)]',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cx('pt-5', className)} {...props} />;
}
