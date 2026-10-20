'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

/**
 * Título (`h1`) e subtítulo da página de entrada. Na página de motivo o foco inicial vai para o
 * título (SCR-001 — acessibilidade): quem usa leitor de tela ouve o contexto antes do botão.
 */
export function LoginTitle() {
  const t = useTranslations('auth.login');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-bold tracking-tight text-foreground outline-none sm:text-4xl"
      >
        {t('title')}
      </h1>
      <p className="mt-3 text-lg text-muted-foreground">{t('subtitle')}</p>
    </>
  );
}
