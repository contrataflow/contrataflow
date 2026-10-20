import { getTranslations } from 'next-intl/server';

import { UsersView } from '@/features/users/users-view';

/**
 * Administração › Usuários (SCR-029 · US-091): convites pendentes carregados no cliente; a própria
 * API decide o acesso (`USER_VIEW` — RN-FND-92) e a tela trata o 403.
 */
export default async function UsersPage() {
  const t = await getTranslations('users');
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>
      <UsersView />
    </div>
  );
}
