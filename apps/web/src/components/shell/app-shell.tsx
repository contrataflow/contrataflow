import { Alert, BrandLogo, SkipLink, brandingTheme } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { CSSProperties, ReactNode } from 'react';

import { isExamplePageEnabled } from '@/config/env';
import { NotificationBell } from '@/features/notifications/notification-bell';
import { HOME_PATH } from '@/lib/routes';
import type { ActiveShellSession } from '@/lib/session/types';

import { GlobalSearch } from './global-search';
import { HelpButton } from './help-button';
import { MainNav } from './main-nav';
import { MobileNav } from './mobile-nav';
import { RouteFocus } from './route-focus';
import { TenantSwitcher } from './tenant-switcher';
import { UserCard } from './user-card';

export const MAIN_CONTENT_ID = 'conteudo';

/**
 * Shell autenticado de `(app)` (architecture.md §8.2 · prd-6 §2.2, padrão do Microlegis): barra
 * lateral clara com os itens do dia a dia, o grupo "Sistema" (Administração recolhível) e o cartão
 * do usuário no rodapé; barra superior com a busca em pílula (Ctrl K), ajuda, notificações e o
 * bloco da instituição ativa. "Novo processo" fica no cabeçalho da lista de processos e na paleta
 * Ctrl K. Abaixo de 1024 px a barra lateral vira gaveta. Server Component; só as folhas interativas são client
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
        {/*
         * Menu preso pelo rodapé (`sticky bottom-0` + `self-end`): quando cabe na altura da janela
         * fica fixo; quando não cabe (janela baixa, Administração aberta), rola junto com a página
         * até o cartão do usuário aparecer e então para — nunca corta itens nem rola por dentro.
         */}
        <aside className="sticky bottom-0 hidden min-h-screen w-60 flex-none flex-col gap-2 self-end border-r border-border bg-sidebar pt-4 pb-3 text-sidebar-foreground lg:flex">
          <Link
            href={HOME_PATH}
            className="mx-3 mb-1 flex flex-none items-center rounded-control px-2.5 py-1 focus-visible:outline-sidebar-accent"
          >
            <BrandLogo size="sm" name={t('appName')} />
          </Link>
          <MainNav showExample={showExample} />
          <UserCard />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex min-h-15 flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-border bg-surface px-4 py-2.5 sm:px-6 lg:px-7">
            <MobileNav showExample={showExample} />
            <GlobalSearch showExample={showExample} />
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <HelpButton />
              <NotificationBell />
              <TenantSwitcher />
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
