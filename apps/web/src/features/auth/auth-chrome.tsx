'use client';

import { BrandLogo } from '@contrataflow/ui';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** Rota da página de entrada, que traz a própria marca na moldura de login. */
export const LOGIN_PATH = '/entrar';
/** Prefixo das páginas de erro (SCR-111), as únicas do grupo sem a moldura de login. */
const ERROR_PREFIX = '/erro/';

/**
 * Casca do grupo `(auth)` (architecture.md §8.2 · RN-FND-87): sem shell, sem menu. Entrada,
 * recuperação de senha, seleção de instituição e convite usam a `LoginFrame` (painel institucional
 * + acesso), que traz a própria marca; as páginas de erro levam só a marca no topo e o conteúdo
 * centrado.
 *
 * Decide pelo caminho no cliente porque layouts não são renderizados de novo ao navegar entre
 * páginas irmãs — uma decisão no servidor ficaria presa à primeira página visitada.
 */
export function AuthChrome({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('shell');

  if (!pathname.startsWith(ERROR_PREFIX)) {
    return (
      <main id="conteudo" className="min-h-screen bg-surface">
        {children}
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-16 items-center px-4 sm:px-8">
        <BrandLogo size="sm" name={t('appName')} />
      </header>
      <main id="conteudo" className="flex flex-1 items-center justify-center px-4 pb-16">
        {children}
      </main>
    </div>
  );
}
