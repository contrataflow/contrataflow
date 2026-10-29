'use client';

import { ViewTabs } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';

import { OrganizationsView } from './organizations-view';
import { DepartmentsView } from '../departments/departments-view';

const TABS = ['organizations', 'departments'] as const;
type Tab = (typeof TABS)[number];
const PANEL_ID = 'structure-panel';

/**
 * SCR-032 (`/admin/estrutura`): estrutura organizacional em abas — "Órgãos" (US-101) e
 * "Secretarias" (árvore de unidades e assistente de implantação — US-102/US-099). Cabeçalho único
 * com a ação primária da aba ativa (as abas a entregam por portal); abas do kit (`ViewTabs`) que
 * quebram linha em vez de rolar, com setas esquerda/direita, Home/End.
 */
export function StructureView() {
  const t = useTranslations('organizations');
  const [tab, setTab] = useState<Tab>('organizations');
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);

  return (
    <section className="flex min-w-0 flex-col gap-5">
      <AppPageHeader
        section="admin"
        title={t('title')}
        description={t('description')}
        actions={
          <div ref={setActionsSlot} className="flex flex-wrap items-end gap-2.5 empty:hidden" />
        }
      />
      <ViewTabs
        label={t('tabs.label')}
        panelId={PANEL_ID}
        value={tab}
        onValueChange={(next) => {
          setTab(next as Tab);
        }}
        tabs={TABS.map((item) => ({ id: item, label: t(`tabs.${item}`) }))}
      />
      <div role="tabpanel" id={PANEL_ID} aria-label={t(`tabs.${tab}`)}>
        {tab === 'organizations' ? (
          <OrganizationsView actionsSlot={actionsSlot} />
        ) : (
          <DepartmentsView actionsSlot={actionsSlot} />
        )}
      </div>
    </section>
  );
}
