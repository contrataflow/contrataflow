import { useTranslations } from 'next-intl';

import { SUPPORT_HREF } from '@/features/auth/help-link';

/**
 * "Precisa de ajuda?" no rodapé da barra lateral (prd-4 · padrão 1). Sem central de ajuda ainda
 * (`/ajuda`), o link segue o canal de suporte da moldura de entrada (`SUPPORT_HREF`).
 */
export function SidebarHelp() {
  const t = useTranslations('shell.help');
  return (
    <div className="mx-3.5 flex flex-col gap-1.5 rounded-xl bg-background px-3 pt-3.5 pb-1.5">
      <p className="text-[0.8125rem] font-semibold text-brand-ink">{t('title')}</p>
      <p className="text-xs leading-normal text-muted-foreground">{t('description')}</p>
      <a
        href={SUPPORT_HREF}
        className="inline-flex min-h-11 items-center text-[0.8125rem] font-semibold text-primary-hover hover:underline focus-visible:outline-sidebar-accent"
      >
        {t('link')}
      </a>
    </div>
  );
}
