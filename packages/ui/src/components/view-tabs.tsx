'use client';

import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

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
 * sem, um `tablist` com seta esquerda/direita, Home e End (WAI-ARIA Tabs, ativação automática).
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
  const listRef = useRef<HTMLDivElement>(null);
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

  function select(index: number) {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onValueChange?.(tab.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${tab.id}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={container}>
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange?.(tab.id)}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            className={cx(TAB, active ? ACTIVE : IDLE)}
          >
            {tab.label}
            {tab.count === undefined ? null : ' '}
            {tab.count === undefined ? null : <Count value={tab.count} active={active} />}
          </button>
        );
      })}
    </div>
  );
}
