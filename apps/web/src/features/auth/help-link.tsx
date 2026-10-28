import { useTranslations } from 'next-intl';

import { AuthIcon } from './auth-icons';

/*
 * Canal de suporte da moldura de entrada. Ainda não existe central de ajuda (`/ajuda`): até o
 * produto definir o canal oficial, o link abre o e-mail de suporte da plataforma. Trocar o
 * destino é mudar só esta constante.
 */
export const SUPPORT_HREF = 'mailto:suporte@contrataflow.com.br';

/** "Precisa de ajuda?" no topo do painel de acesso (SCR-001). */
export function HelpLink() {
  const t = useTranslations('auth.login.help');
  return (
    <a
      href={SUPPORT_HREF}
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary-hover hover:text-brand-ink hover:underline"
    >
      <AuthIcon name="help" className="size-[1.125rem]" />
      {t('link')}
    </a>
  );
}
