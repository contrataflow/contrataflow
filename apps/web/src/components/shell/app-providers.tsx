'use client';

import { Toaster, toast } from '@contrataflow/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { ConflictDialog } from '@/components/errors/conflict-dialog';
import { LogoutGuard } from '@/components/session/logout-guard';
import { SessionWatcher } from '@/components/session/session-watcher';
import { PreferencesApplier } from '@/features/profile/preferences-applier';
import { applyErrorEffect } from '@/lib/api/error-effects';
import type { ErrorEffectDeps } from '@/lib/api/error-effects';
import { localDrafts } from '@/lib/drafts/local-drafts';
import { PermissionProvider } from '@/lib/permissions/use-permission';
import { makeQueryClient, subscribeToErrors } from '@/lib/query/query-client';
import { ShellSessionProvider } from '@/lib/session/session-context';
import { SessionSync } from '@/lib/session/session-sync';
import type { ActiveShellSession } from '@/lib/session/types';

/**
 * Providers do shell autenticado: QueryClient (um por aba), sessão, permissões efetivas (ME-03 —
 * US-097), sincronização entre abas, contador de sessão e "Sair" com confirmação (US-088), política
 * global de erros, diálogo de conflito e toasts.
 */
export function AppProviders({
  session,
  children,
}: {
  readonly session: ActiveShellSession;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations('errors');
  const [conflictOpen, setConflictOpen] = useState(false);
  const [queryClient] = useState(() => makeQueryClient());

  const deps = useMemo<ErrorEffectDeps>(
    () => ({
      currentPath: () => `${window.location.pathname}${window.location.search}`,
      navigate: (href) => {
        window.location.assign(href);
      },
      openConflict: () => {
        setConflictOpen(true);
      },
      notify: (input) => {
        toast(input);
      },
      messages: {
        rateLimited: (seconds) =>
          seconds === null ? t('toast.rateLimited') : t('toast.rateLimitedWait', { seconds }),
        csrf: t('toast.csrf'),
        csrfHint: t('toast.csrfHint'),
        unexpected: t('toast.unexpected'),
        notFound: t('pages.404.title'),
        correlation: (correlationId) => t('correlation.label', { correlationId }),
      },
    }),
    [t],
  );

  // Outro usuário neste navegador: rascunhos locais de terceiros são apagados (RN-IAM-30).
  useEffect(() => {
    void localDrafts()
      .purgeForeign(session.user.id)
      .catch(() => undefined);
  }, [session.user.id]);

  useEffect(
    () =>
      subscribeToErrors(queryClient, (error, source) => {
        applyErrorEffect(error, source, deps);
      }),
    [queryClient, deps],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ShellSessionProvider session={session}>
        <PermissionProvider>
          <LogoutGuard>
            <SessionSync />
            <SessionWatcher />
            <PreferencesApplier />
            {children}
            <ConflictDialog
              open={conflictOpen}
              onOpenChange={setConflictOpen}
              onReload={() => {
                setConflictOpen(false);
                void queryClient.invalidateQueries();
                router.refresh();
              }}
            />
            <Toaster label="Notificações ({hotkey})" closeLabel="Fechar" />
          </LogoutGuard>
        </PermissionProvider>
      </ShellSessionProvider>
    </QueryClientProvider>
  );
}
