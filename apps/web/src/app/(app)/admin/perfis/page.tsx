import { getTranslations } from 'next-intl/server';

import { AppPageHeader } from '@/components/shell/page-header';
import { RolesView } from '@/features/roles/roles-view';

/**
 * Administração › Perfis e permissões (SCR-030 · US-095): lista de perfis carregada no cliente; a
 * própria API decide o acesso (`ROLE_VIEW` — RN-FND-92) e a tela trata o 403.
 */
export default async function RolesPage() {
  const t = await getTranslations('roles');
  return (
    <div className="flex flex-col gap-6">
      <AppPageHeader section="admin" title={t('title')} description={t('description')} />
      <RolesView />
    </div>
  );
}
