import { BrandLogo } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { HelpLink } from './help-link';
import { LoginBrandPanel } from './login-brand-panel';
import { PrivacyNotice } from './privacy-notice';

/**
 * Moldura de entrada (SCR-001 · mockup `docs/brand/mockups/repaginacao-2026-10/Main.dc.html`):
 * tela inteira com o painel institucional navy à esquerda (a partir de 1024 px) e o acesso em
 * fundo branco à direita — ajuda no topo, o conteúdo da página (`children`) centrado em até
 * 420 px e o aviso de privacidade no rodapé. Abaixo de 1024 px fica só o acesso, com a marca no
 * topo. Sem imagem de fundo com texto e sem identidade de instituição. Reaproveitada nas telas
 * secundárias de acesso (recuperar senha, selecionar instituição, convite — prd-5 · card 10);
 * `wide` abre o conteúdo para 560 px (lista de instituições).
 */
export function LoginFrame({
  children,
  wide = false,
}: {
  readonly children: ReactNode;
  readonly wide?: boolean | undefined;
}) {
  const t = useTranslations('auth.login.brand');
  return (
    <div className="flex min-h-screen w-full bg-surface">
      <LoginBrandPanel />
      <section
        aria-label={t('accessLabel')}
        className="flex min-w-0 flex-1 flex-col px-4 py-5 sm:px-12 lg:py-7"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
          <span className="lg:hidden">
            <BrandLogo size="md" name={t('name')} tagline={t('slogan')} />
          </span>
          <span className="ml-auto">
            <HelpLink />
          </span>
        </div>
        <div className={`mx-auto my-auto w-full py-8 ${wide ? 'max-w-[560px]' : 'max-w-[420px]'}`}>
          {children}
        </div>
        <PrivacyNotice />
      </section>
    </div>
  );
}
