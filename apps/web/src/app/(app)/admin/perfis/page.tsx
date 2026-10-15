import { getTranslations } from 'next-intl/server';

import { PermissionCatalogPanel } from '@/features/permissions/permission-catalog-panel';

/**
 * Administração › Perfis e permissões (US-094). Por ora só o catálogo de permissões (ROL-01),
 * carregado no cliente: a própria API decide o acesso (`ROLE_VIEW` — RN-FND-92) e a tela trata o
 * 403. A lista de perfis e a matriz SCR-030/031 chegam com a US-095.
 */
export default async function RolesPage() {
  const t = await getTranslations('permissions.page');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <PermissionCatalogPanel />
    </div>
  );
}
