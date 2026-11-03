import { Tooltip, TooltipContent, TooltipTrigger, buttonClassName } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { SUPPORT_HREF } from '@/features/auth/help-link';

import { Icon } from './icons';

/**
 * Ajuda na barra superior (prd-6 · §2.2): ícone com dica que leva ao canal de suporte da
 * plataforma. Sem central de ajuda ainda (`/ajuda`), o link segue o `SUPPORT_HREF` da moldura de
 * entrada.
 */
export function HelpButton() {
  const t = useTranslations('shell.help');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={SUPPORT_HREF}
          aria-label={t('label')}
          className={buttonClassName({ variant: 'secondary', size: 'icon' })}
        >
          <Icon name="help" className="size-5 text-muted-foreground" />
        </a>
      </TooltipTrigger>
      <TooltipContent>{t('tooltip')}</TooltipContent>
    </Tooltip>
  );
}
