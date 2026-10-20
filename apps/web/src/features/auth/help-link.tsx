import { useTranslations } from 'next-intl';

/*
 * Canal de suporte da moldura de entrada. Ainda não existe central de ajuda (`/ajuda`): até o
 * produto definir o canal oficial, o link abre o e-mail de suporte da plataforma. Trocar o
 * destino é mudar só esta constante.
 */
export const SUPPORT_HREF = 'mailto:suporte@contrataflow.com.br';

/** "Precisa de ajuda? Suporte" no topo do painel de acesso (SCR-001). */
export function HelpLink() {
  const t = useTranslations('auth.login.help');
  return (
    <p className="text-right text-sm text-muted-foreground">
      {t('prompt')}{' '}
      <a
        href={SUPPORT_HREF}
        className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
      >
        {t('link')}
      </a>
    </p>
  );
}
