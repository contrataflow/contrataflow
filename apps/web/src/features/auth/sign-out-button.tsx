'use client';

import { Alert, Button } from '@contrataflow/ui';
import type { ButtonVariant } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { makeQueryClient } from '@/lib/query/query-client';
import { logout } from '@/lib/session/session-actions';

import { AuthIcon } from './auth-icons';

/**
 * "Sair" das páginas sem a casca do shell (sem vínculo, acesso bloqueado, seleção de
 * instituição): `POST /api/auth/logout` com CSRF e navegação para o `redirectTo` do BFF (fim de
 * sessão no provedor ou `/entrar?motivo=saiu`). Se a chamada nem sair do navegador (rede), a
 * sessão continua ativa: avisa e permite tentar de novo, em vez de fingir que saiu.
 */
export function SignOutButton({
  variant = 'primary',
  withIcon = false,
  className,
}: {
  readonly variant?: ButtonVariant | undefined;
  readonly withIcon?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const t = useTranslations('auth.signOut');
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle');

  const signOut = async () => {
    setState('pending');
    try {
      await logout({
        // Páginas deste grupo não têm cache de consultas; o cliente só satisfaz a ação compartilhada.
        queryClient: makeQueryClient(),
        navigate: (href) => {
          window.location.assign(href);
        },
      });
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="flex flex-col items-start gap-3">
      {state === 'failed' ? <Alert tone="error" title={t('failed')} /> : null}
      <Button
        variant={variant}
        className={className}
        aria-busy={state === 'pending'}
        aria-disabled={state === 'pending' || undefined}
        onClick={() => {
          if (state !== 'pending') void signOut();
        }}
      >
        {withIcon ? <AuthIcon name="logout" className="size-4" /> : null}
        {state === 'pending' ? t('pending') : t('label')}
      </Button>
    </div>
  );
}
