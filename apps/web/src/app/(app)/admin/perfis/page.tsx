import { getTranslations } from 'next-intl/server';

import { RolesView } from '@/features/roles/roles-view';

/**
 * Administração › Perfis e permissões (SCR-030 · US-095): lista de perfis carregada no cliente; a
 * própria API decide o acesso (`ROLE_VIEW` — RN-FND-92) e a tela trata o 403.
 */
export default async function RolesPage() {
  const t = await getTranslations('roles');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <RolesView />
    </div>
  );
}
