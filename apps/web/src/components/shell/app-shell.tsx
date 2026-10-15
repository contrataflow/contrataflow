import { Alert, SkipLink, brandingTheme } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { CSSProperties, ReactNode } from 'react';

import { NotificationBell } from '@/features/notifications/notification-bell';
import type { ActiveShellSession } from '@/lib/session/types';

import { Icon } from './icons';
import { MainNav } from './main-nav';
import { MobileNav } from './mobile-nav';
import { RouteFocus } from './route-focus';
import { TenantSwitcher } from './tenant-switcher';
import { UserMenu } from './user-menu';

export const MAIN_CONTENT_ID = 'conteudo';

/**
 * Shell autenticado de `(app)` (architecture.md §8.2): menu, busca, notificações, seletor de
 * instituição e usuário. Server Component; só as folhas interativas são client (RN-FND-88).
 * Tema do tenant restrito à cor primária com contraste validado (RN-FND-91).
 */
export function AppShell({
  session,
  children,
}: {
  readonly session: ActiveShellSession;
  readonly children: ReactNode;
}) {
  const t = useTranslations('shell');
  const theme = brandingTheme(session.activeTenant.primaryColor);
  return (
    <div
      style={(theme ?? undefined) as CSSProperties | undefined}
      className="min-h-screen bg-background text-foreground"
    >
      <SkipLink targetId={MAIN_CONTENT_ID}>{t('skipLink')}</SkipLink>
      <RouteFocus targetId={MAIN_CONTENT_ID} />
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-64 flex-none flex-col border-r border-border bg-surface md:flex">
          <Link
            href="/exemplo"
            className="flex h-14 flex-none items-center gap-2 border-b border-border px-4"
          >
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-control bg-primary text-sm font-bold text-primary-foreground"
            >
              CF
            </span>
            <span className="text-base font-semibold tracking-tight">{t('appName')}</span>
          </Link>
          <MainNav />
          <p className="border-t border-border p-3 text-xs text-muted-foreground">{t('footer')}</p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
            <MobileNav />
            <form role="search" action="/processos" className="hidden md:block">
              <label className="relative block">
                <span className="sr-only">{t('search.label')}</span>
                <Icon
                  name="search"
                  className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
                />
                <input
                  type="search"
                  name="q"
                  placeholder={t('search.placeholder')}
                  className="h-9 w-72 rounded-control border border-border bg-surface pr-3 pl-8 text-sm placeholder:text-muted-foreground"
                />
              </label>
            </form>
            <div className="ml-auto flex flex-none items-center gap-2">
              <TenantSwitcher />
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          {session.readOnly ? (
            <Alert
              tone="warning"
              title={t('readOnly')}
              live={false}
              className="rounded-none border-x-0 border-t-0"
            />
          ) : null}
          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            className="flex-1 px-4 py-6 outline-none sm:px-6"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
