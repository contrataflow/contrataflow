'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cx } from '../lib/cx.js';
import { PlainLink } from '../lib/tones.js';
import type { LinkComponent } from '../lib/tones.js';

export interface ViewTab {
  readonly id: string;
  readonly label: ReactNode;
  /** Contador da visão (ex.: processos que ela lista); omitido quando desconhecido. */
  readonly count?: number | undefined;
  /** Visões salvas na URL: com `href`, a aba é um link (`aria-current="page"` na ativa). */
  readonly href?: string | undefined;
}

export interface ViewTabsProps {
  readonly tabs: readonly ViewTab[];
  /** `id` da visão ativa. */
  readonly value: string;
  /** Troca de visão sem URL (abas `role="tab"`); ignorado nas abas com `href`. */
  readonly onValueChange?: ((id: string) => void) | undefined;
  /** Nome acessível do conjunto (ex.: "Visões salvas"). */
  readonly label: string;
  /** `id` do painel controlado pelas abas (`aria-controls`). */
  readonly panelId?: string | undefined;
  readonly linkComponent?: LinkComponent | undefined;
  readonly className?: string | undefined;
}

const TAB =
  'inline-flex min-h-11 items-center gap-2 px-3.5 text-sm whitespace-nowrap transition-colors';
const ACTIVE =
  'font-bold text-primary-soft-foreground shadow-[inset_0_-2px_0_var(--color-primary)]';
const IDLE = 'font-medium text-muted-foreground hover:text-foreground';

function Count({ value, active }: { readonly value: number; readonly active: boolean }) {
  return (
    <span
      className={cx(
        'rounded-full px-2 py-px text-xs font-bold',
        active
          ? 'bg-primary-soft text-primary-soft-foreground'
          : 'bg-neutral-soft text-neutral-soft-foreground',
      )}
    >
      {value}
    </span>
  );
}

/**
 * Visões salvas em abas com contador (prd-4 · padrão 6). Com `href`, é uma navegação por links;
 * sem, um `tablist` (Radix Tabs) com seta esquerda/direita, Home e End (WAI-ARIA Tabs, ativação
 * automática). Quebra linha em vez de rolar (prd-5 · regra 8).
 */
export function ViewTabs({
  tabs,
  value,
  onValueChange,
  label,
  panelId,
  linkComponent: Link = PlainLink,
  className,
}: ViewTabsProps) {
  const container = cx('flex flex-wrap gap-1 border-b border-border', className);

  if (tabs.every((tab) => tab.href !== undefined)) {
    return (
      <nav aria-label={label} className={container}>
        {tabs.map((tab) => {
          const active = tab.id === value;
          return (
            <Link
              key={tab.id}
              href={tab.href ?? ''}
              aria-current={active ? 'page' : undefined}
              className={cx(TAB, active ? ACTIVE : IDLE)}
            >
              {tab.label}
              {tab.count === undefined ? null : ' '}
              {tab.count === undefined ? null : <Count value={tab.count} active={active} />}
            </Link>
          );
        })}
      </nav>
    );
  }

  // Sem URL: Radix Tabs por baixo (setas, Home/End, ativação automática, foco itinerante). Só a
  // lista é renderizada; o painel fica com quem usa, ligado por `panelId`.
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(id) => onValueChange?.(id)}
      activationMode="automatic"
    >
      <TabsPrimitive.List aria-label={label} className={container}>
        {tabs.map((tab) => {
          const active = tab.id === value;
          return (
            <TabsPrimitive.Trigger
              key={tab.id}
              value={tab.id}
              data-tab-id={tab.id}
              aria-controls={panelId}
              className={cx(TAB, active ? ACTIVE : IDLE)}
            >
              {tab.label}
              {tab.count === undefined ? null : ' '}
              {tab.count === undefined ? null : <Count value={tab.count} active={active} />}
            </TabsPrimitive.Trigger>
          );
        })}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
