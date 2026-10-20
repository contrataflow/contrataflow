'use client';

import { buttonClassName } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { AuthIcon } from './auth-icons';

/**
 * "Entrar" da página de motivo: link para `GET /api/auth/login` (preserva `returnTo`) com o
 * estado "Redirecionando…" após o clique. É um link, não um botão: a navegação é a ação, e
 * funciona mesmo sem JavaScript.
 */
export function LoginSubmitLink({ href }: { readonly href: string }) {
  const t = useTranslations('auth.login');
  const [redirecting, setRedirecting] = useState(false);

  // Voltar do provedor de identidade pelo histórico restaura a página do cache (bfcache): o botão
  // não pode ficar preso em "Redirecionando…".
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pageshow', restore);
    };
  }, []);

  return (
    <a
      href={href}
      aria-busy={redirecting}
      aria-disabled={redirecting || undefined}
      className={buttonClassName({
        size: 'md',
        className:
          'h-12 w-full bg-brand-navy! text-base font-semibold shadow-sm hover:bg-brand-blue-deep!',
      })}
      onClick={(event) => {
        // Segundo clique durante o redirecionamento não reinicia o fluxo.
        if (redirecting) {
          event.preventDefault();
          return;
        }
        // Ctrl/Cmd/Shift+clique abre em outra aba/janela: esta página continua como está.
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
          setRedirecting(true);
        }
      }}
    >
      {redirecting ? t('redirecting') : t('submit')}
      {redirecting ? null : <AuthIcon name="arrowRight" />}
    </a>
  );
}
