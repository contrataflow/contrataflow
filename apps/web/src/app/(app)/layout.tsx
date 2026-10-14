import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { currentPathname, currentSession } from '@/bff/server-session';
import { toShellSession } from '@/bff/session/view';
import { AppProviders } from '@/components/shell/app-providers';
import { AppShell } from '@/components/shell/app-shell';
import { LOCALE, messages } from '@/i18n/messages';
import { loginHref } from '@/lib/api/error-policy';
import type { ActiveShellSession } from '@/lib/session/types';

// Nenhuma página autenticada é cacheada (RN-FND-88).
export const dynamic = 'force-dynamic';

/**
 * Grupo `(app)` (RN-FND-87): resolve sessão e instituição ativa no servidor antes de renderizar
 * qualquer filho — sem sessão → login com `returnTo`; sem instituição → seleção de órgão.
 */
export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const lookup = await currentSession();
  if (lookup.status !== 'active') redirect(loginHref(await currentPathname()));
  const session = toShellSession(lookup.record);
  if (!session.activeTenant) redirect('/selecionar-orgao');
  const active: ActiveShellSession = { ...session, activeTenant: session.activeTenant };

  return (
    // Datas no fuso da instituição ativa (DEC-003 · RN-FND-95).
    <NextIntlClientProvider
      locale={LOCALE}
      messages={messages}
      timeZone={active.activeTenant.timezone}
    >
      <AppProviders session={active}>
        <AppShell session={active}>{children}</AppShell>
      </AppProviders>
    </NextIntlClientProvider>
  );
}
