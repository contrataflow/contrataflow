'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { fetchActiveTenantId } from './session-actions';
import { subscribeSessionEvents } from './session-channel';
import { useTenantId } from './session-context';

/**
 * Mantém as abas coerentes (FA-03): ao saber de outra aba que trocou de instituição, apaga o
 * cache na hora (nenhum dado do tenant anterior fica na tela) e recarrega ao voltar o foco; no
 * `focus`, confere o `activeTenantId` do BFF. Logout/expiração em outra aba levam ao login.
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
      queryClient.clear();
      navigate(event.type === 'logout' ? '/entrar?motivo=saiu' : '/entrar?motivo=sessao-expirada');
    });

    const onFocus = () => {
      void fetchActiveTenantId().then((probe) => {
        if (probe.kind === 'no-session') {
          queryClient.clear();
          navigate(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        if (stale.current || (probe.tenantId !== null && probe.tenantId !== tenantId)) {
          stale.current = false;
          queryClient.clear();
          router.refresh();
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
