'use client';

import { cx } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';

import { OrganizationsView } from './organizations-view';
import { DepartmentsView } from '../departments/departments-view';

const TABS = ['organizations', 'departments'] as const;
type Tab = (typeof TABS)[number];

/**
 * SCR-032 (`/admin/estrutura`): estrutura organizacional em abas — "Órgãos" (US-101) e
 * "Secretarias" (árvore de unidades e assistente de implantação — US-102/US-099). Abas ARIA com
 * setas esquerda/direita, Home/End.
 */
export function StructureView() {
  const t = useTranslations('organizations');
  const [tab, setTab] = useState<Tab>('organizations');
  const refs = useRef(new Map<Tab, HTMLButtonElement>());

  const select = (next: Tab) => {
    setTab(next);
    refs.current.get(next)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    select(next);
  };

  return (
    <section className="flex flex-col gap-6">
      <AppPageHeader section="admin" title={t('title')} description={t('description')} />
      <div
        role="tablist"
        aria-label={t('tabs.label')}
        className="flex gap-2 border-b border-border"
      >
        {TABS.map((item) => (
          <button
            key={item}
            ref={(element) => {
              if (element) refs.current.set(item, element);
            }}
            type="button"
            role="tab"
            id={`structure-tab-${item}`}
            aria-selected={tab === item}
            aria-controls={`structure-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => {
              setTab(item);
            }}
            onKeyDown={onKeyDown}
            className={cx(
              'border-b-2 px-3 py-2 text-sm font-medium',
              tab === item ? 'border-primary' : 'border-transparent text-muted-foreground',
            )}
          >
            {t(`tabs.${item}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`structure-panel-${tab}`} aria-labelledby={`structure-tab-${tab}`}>
        {tab === 'organizations' ? <OrganizationsView /> : <DepartmentsView />}
      </div>
    </section>
  );
}
