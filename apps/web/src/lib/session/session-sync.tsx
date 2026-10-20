'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { MEMBERSHIP_INACTIVE_HREF, loginHref } from '@/lib/api/error-policy';

import { LOGGED_OUT_PATH, fetchSessionState } from './session-actions';
import { subscribeSessionEvents } from './session-channel';
import { useTenantId } from './session-context';
import { emitSessionSignal } from './session-signals';

/**
 * Mantém as abas coerentes (FA-03 · RN-IAM-29): ao saber de outra aba que trocou de instituição,
 * apaga o cache na hora (nenhum dado do tenant anterior fica na tela) e recarrega ao voltar o foco;
 * logout em outra aba leva à SCR-001 (expiração e "Continuar conectado" ficam com o
 * `SessionWatcher`).
 * No `focus`, confere a sessão no BFF sem renovar a ociosidade.
 */
export function SessionSync({ onNavigate }: { readonly onNavigate?: (href: string) => void }) {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const stale = useRef(false);

  useEffect(() => {
    const navigate =
      onNavigate ??
      ((href: string) => {
        window.location.assign(href);
      });
    const unsubscribe = subscribeSessionEvents((event) => {
      if (event.type === 'tenant-switched') {
        if (event.tenantId === tenantId) return;
        queryClient.clear();
        stale.current = true;
        if (document.visibilityState === 'visible' && document.hasFocus()) {
          stale.current = false;
          router.refresh();
        }
        return;
      }
      if (event.type === 'logout') {
        queryClient.clear();
        navigate(LOGGED_OUT_PATH);
      }
      // `expired`/`extended`: tratados pelo `SessionWatcher` (modal e contador).
    });

    const onFocus = () => {
      void fetchSessionState().then((state) => {
        switch (state.kind) {
          case 'no-session':
            queryClient.clear();
            navigate(loginHref(window.location.pathname));
            return;
          case 'expired':
            emitSessionSignal({ type: 'expired' });
            return;
          case 'membership-inactive':
            queryClient.clear();
            navigate(MEMBERSHIP_INACTIVE_HREF);
            return;
          case 'unavailable':
            return;
          case 'active': {
            const active = state.session.activeTenant?.id ?? null;
            if (stale.current || (active !== null && active !== tenantId)) {
              stale.current = false;
              queryClient.clear();
              router.refresh();
            }
          }
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [tenantId, queryClient, router, onNavigate]);

  return null;
}
