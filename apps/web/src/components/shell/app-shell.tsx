import { Alert, BrandLogo, SkipLink, brandingTheme } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { CSSProperties, ReactNode } from 'react';

import { isExamplePageEnabled } from '@/config/env';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { NewProcessButton } from '@/features/processes/new-process-button';
import { HOME_PATH } from '@/lib/routes';
import type { ActiveShellSession } from '@/lib/session/types';

import { GlobalSearch } from './global-search';
import { MainNav } from './main-nav';
import { MobileNav } from './mobile-nav';
import { RouteFocus } from './route-focus';
import { SidebarHelp } from './sidebar-help';
import { TenantSwitcher } from './tenant-switcher';
import { UserMenu } from './user-menu';

export const MAIN_CONTENT_ID = 'conteudo';

/**
 * Shell autenticado de `(app)` (architecture.md §8.2 · prd-4): barra lateral clara com grupos,
 * barra superior com busca global (Ctrl K), seletor de instituição, notificações e usuário; abaixo
 * de 1024 px a barra lateral vira gaveta. Server Component; só as folhas interativas são client
 * (RN-FND-88). Tema do tenant restrito à cor primária com contraste validado (RN-FND-91): o item
 * ativo do menu e as ações primárias a seguem.
 */
export function AppShell({
  session,
  children,
}: {
  readonly session: ActiveShellSession;
  readonly children: ReactNode;
}) {
  const t = useTranslations('shell');
  const showExample = isExamplePageEnabled();
  const theme = brandingTheme(session.activeTenant.primaryColor);
  return (
    <div
      style={(theme ?? undefined) as CSSProperties | undefined}
      className="min-h-screen bg-background text-foreground"
    >
      <SkipLink targetId={MAIN_CONTENT_ID}>{t('skipLink')}</SkipLink>
      <RouteFocus targetId={MAIN_CONTENT_ID} />
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-62 flex-none flex-col gap-6 border-r border-border bg-sidebar pt-5 pb-4 text-sidebar-foreground lg:flex">
          <Link
            href={HOME_PATH}
            className="mx-3.5 flex flex-none items-center rounded-control px-2.5 py-1 focus-visible:outline-sidebar-accent"
          >
            <BrandLogo size="sm" name={t('appName')} />
          </Link>
          <MainNav showExample={showExample} />
          <SidebarHelp />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-border bg-surface px-4 py-3 sm:px-6 lg:px-8">
            <MobileNav showExample={showExample} />
            <GlobalSearch />
            <div className="ml-auto flex flex-none flex-wrap items-center gap-2">
              <NewProcessButton />
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
            className="flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-7"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
