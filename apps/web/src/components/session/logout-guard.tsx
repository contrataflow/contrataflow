'use client';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { localDrafts } from '@/lib/drafts/local-drafts';
import type { LocalDrafts } from '@/lib/drafts/local-drafts';
import { logout } from '@/lib/session/session-actions';
import { useShellSession } from '@/lib/session/session-context';

interface LogoutContextValue {
  /** "Sair": confirma antes se houver rascunho não sincronizado (RN-IAM-31). */
  readonly requestLogout: () => void;
}

const LogoutContext = createContext<LogoutContextValue | null>(null);

/**
 * `LogoutGuard` (US-088 · RN-IAM-31): todo "Sair" do shell (menu do avatar, diálogo de
 * ociosidade) passa por aqui. Com rascunho local não sincronizado, a interface confirma; ao sair,
 * o cache, os rascunhos do usuário e o `sessionStorage` são limpos e as outras abas avisadas.
 */
export function LogoutGuard({
  children,
  drafts,
  onNavigate,
}: {
  readonly children: ReactNode;
  readonly drafts?: LocalDrafts | undefined;
  readonly onNavigate?: ((href: string) => void) | undefined;
}) {
  const t = useTranslations('shell.session');
  const queryClient = useQueryClient();
  const { user } = useShellSession();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const signOut = useCallback(async () => {
    setConfirming(false);
    setPending(true);
    try {
      await logout({
        queryClient,
        userId: user.id,
        ...(drafts ? { drafts } : {}),
        navigate:
          onNavigate ??
          ((href) => {
            window.location.assign(href);
          }),
      });
    } catch {
      // Sem resposta do BFF (rede): a sessão continua ativa — avisa em vez de fingir que saiu.
      setPending(false);
      toast({ title: t('logoutFailed'), tone: 'error' });
    }
  }, [drafts, onNavigate, queryClient, t, user.id]);

  const requestLogout = useCallback(() => {
    if (pending) return;
    void (drafts ?? localDrafts())
      .hasUnsynced(user.id)
      .catch(() => false)
      .then((unsynced) => {
        if (unsynced) setConfirming(true);
        else void signOut();
      });
  }, [drafts, pending, signOut, user.id]);

  const value = useMemo(() => ({ requestLogout }), [requestLogout]);

  return (
    <LogoutContext.Provider value={value}>
      {children}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>{t('logoutGuard.title')}</DialogTitle>
          <DialogDescription>{t('logoutGuard.description')}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('logoutGuard.cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void signOut()}>
              {t('logoutGuard.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LogoutContext.Provider>
  );
}

export function useLogout(): LogoutContextValue {
  const value = useContext(LogoutContext);
  if (!value) throw new Error('useLogout fora do LogoutGuard.');
  return value;
}
