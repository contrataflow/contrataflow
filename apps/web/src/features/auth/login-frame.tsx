import { BrandLogo } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { HelpLink } from './help-link';
import { LoginBrandPanel } from './login-brand-panel';
import { PrivacyNotice } from './privacy-notice';

/**
 * Moldura de entrada (SCR-001 · prd-6 §2.7, padrão do Microlegis — prévia em
 * `docs/brand/mockups/repaginacao-2026-11/`): a partir de 1024 px, o painel institucional em
 * degradê navy (58 %) à esquerda e o acesso em fundo branco à direita (42 %) — ajuda no topo, o
 * conteúdo da página (`children`) centrado em até 420 px e, no rodapé, o aviso de privacidade e a
 * empresa. Abaixo de 1024 px fica só o acesso, com a marca no topo. Sem identidade de instituição.
 * Reaproveitada nas telas secundárias de acesso (recuperar senha, selecionar instituição,
 * convite — prd-5 · card 10); `wide` abre o conteúdo para 560 px (lista de instituições).
 */
export function LoginFrame({
  children,
  wide = false,
}: {
  readonly children: ReactNode;
  readonly wide?: boolean | undefined;
}) {
  const t = useTranslations('auth.login');
  return (
    <div className="min-h-screen w-full bg-surface lg:grid lg:grid-cols-[58fr_42fr]">
      <LoginBrandPanel />
      <section
        aria-label={t('brand.accessLabel')}
        className="flex min-h-screen min-w-0 flex-col px-4 py-5 sm:px-12 lg:pt-8 lg:pb-7"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
          <span className="lg:hidden">
            <BrandLogo size="md" name={t('brand.name')} tagline={t('brand.slogan')} />
          </span>
          <span className="ml-auto">
            <HelpLink />
          </span>
        </div>
        <div className={`mx-auto my-auto w-full py-8 ${wide ? 'max-w-[560px]' : 'max-w-[420px]'}`}>
          {children}
        </div>
        <footer className="flex flex-col items-center gap-2">
          <PrivacyNotice />
          <p className="text-[0.8125rem] text-muted-foreground">{t('footer.company')}</p>
        </footer>
      </section>
    </div>
  );
}
