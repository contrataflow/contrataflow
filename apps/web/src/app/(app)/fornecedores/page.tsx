import { getTranslations } from 'next-intl/server';

import { AppPageHeader } from '@/components/shell/page-header';
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
      <AppPageHeader title={t('title')} description={t('description')} />
      <SuppliersView />
    </div>
  );
}
