'use client';

import { useTranslations } from 'next-intl';

import { OrganizationsView } from './organizations-view';

/**
 * SCR-032 (`/admin/estrutura`): estrutura organizacional. A aba "Órgãos" é da US-101; a aba
 * "Secretarias" (árvore de unidades) e o assistente de implantação chegam com a US-102/US-099.
 */
export function StructureView() {
  const t = useTranslations('organizations');
  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <div
        role="tablist"
        aria-label={t('tabs.label')}
        className="flex gap-2 border-b border-border"
      >
        <button
          type="button"
          role="tab"
          id="structure-tab-organizations"
          aria-selected="true"
          aria-controls="structure-panel-organizations"
          className="border-b-2 border-primary px-3 py-2 text-sm font-medium"
        >
          {t('tabs.organizations')}
        </button>
      </div>
      <div
        role="tabpanel"
        id="structure-panel-organizations"
        aria-labelledby="structure-tab-organizations"
      >
        <OrganizationsView />
      </div>
    </section>
  );
}
