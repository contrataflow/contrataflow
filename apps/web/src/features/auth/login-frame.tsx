import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { BrandLogo } from './brand-logo';
import { HelpLink } from './help-link';
import { LoginBrandPanel } from './login-brand-panel';
import { PrivacyNotice } from './privacy-notice';

/**
 * Moldura de entrada de duas colunas (SCR-001 · referência `prototype/entrar.html`): painel
 * institucional à esquerda (a partir de 1024 px) e painel de acesso à direita, com ajuda no topo,
 * o conteúdo da página (`children`) e o selo de privacidade. Abaixo de 1024 px fica só o painel
 * de acesso, com a marca no topo; mínimo de 360 px. Sem identidade visual de instituição.
 */
export function LoginFrame({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('auth.login.brand');
  return (
    <div className="grid w-full max-w-6xl overflow-hidden rounded-2xl bg-surface shadow-2xl lg:grid-cols-2">
      <LoginBrandPanel />
      <section className="flex flex-col px-6 py-8 sm:px-12 lg:px-16 lg:py-12">
        <HelpLink />
        <div className="mt-6 lg:hidden">
          <BrandLogo
            name={t('name')}
            className="gap-2"
            markClassName="size-8"
            nameClassName="text-xl"
          />
        </div>
        <div className="my-auto w-full max-w-md self-center py-8 lg:py-6">
          {children}
          <PrivacyNotice />
        </div>
      </section>
    </div>
  );
}
