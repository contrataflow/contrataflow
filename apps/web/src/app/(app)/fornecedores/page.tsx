import { getTranslations } from 'next-intl/server';

import { SuppliersView } from '@/features/suppliers/suppliers-view';

/**
 * SCR-107 — Fornecedores (`/fornecedores` · US-025): cadastro de fornecedores do tenant, usado nas
 * pesquisas de preços (US-026). A lista é carregada no cliente; a própria API decide o acesso
 * (`SUPPLIER_VIEW` — RN-FND-92) e a tela trata o 403.
 */
export default async function SuppliersPage() {
  const t = await getTranslations('suppliers');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <SuppliersView />
    </div>
  );
}
