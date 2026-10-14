'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Rota da página de entrada, que traz a própria marca na moldura de login. */
export const LOGIN_PATH = '/entrar';

/**
 * Casca do grupo `(auth)` (architecture.md §8.2 · RN-FND-87): sem shell, sem menu. A página de
 * entrada usa o fundo em degradê cinza e a marca da própria moldura; as demais páginas do grupo
 * (recuperar senha, convite, seleção de instituição, erros) levam o cabeçalho com a marca.
 *
 * Decide pelo caminho no cliente porque layouts não são renderizados de novo ao navegar entre
 * páginas irmãs — uma decisão no servidor ficaria presa à primeira página visitada.
 */
export function AuthChrome({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('shell');

  if (pathname === LOGIN_PATH) {
    return (
      <div className="min-h-screen bg-linear-to-br from-slate-200 via-slate-100 to-slate-300">
        <main
          id="conteudo"
          className="flex min-h-screen flex-col items-center justify-center px-4 py-6 sm:px-6 lg:py-10"
        >
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-4">
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-control bg-primary text-sm font-bold text-primary-foreground"
        >
          CF
        </span>
        <span className="text-base font-semibold tracking-tight">{t('appName')}</span>
      </header>
      <main id="conteudo" className="flex flex-1 justify-center px-4">
        {children}
      </main>
    </div>
  );
}
