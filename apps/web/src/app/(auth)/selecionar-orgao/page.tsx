import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { currentShellSession } from '@/bff/server-session';

import { TenantSelection } from './tenant-selection';

/**
 * `/selecionar-orgao` (SCR-101 — a tela definitiva vem com a US-093): destino do layout de
 * `(app)` quando a sessão não tem instituição ativa (FA-02). Exige só sessão.
 */
export default async function SelectTenantPage() {
  const session = await currentShellSession();
  if (!session) redirect('/api/auth/login?returnTo=%2Fselecionar-orgao');
  const usable = session.memberships.filter((membership) => membership.usable);
  if (usable.length === 0) redirect('/erro/sem-vinculo');
  const t = await getTranslations('auth.selectTenant');
  return (
    <section className="flex w-full max-w-md flex-col gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground">{t('description')}</p>
      <TenantSelection memberships={usable} activeTenantId={session.activeTenant?.id ?? null} />
    </section>
  );
}
