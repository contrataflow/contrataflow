'use client';

import { Info } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/**
 * `AiDisclaimer` (SCR-117 · DEC-037): aviso fixo, curto, no rodapé do painel — o conteúdo gerado
 * precisa de revisão.
 */
export function AiDisclaimer() {
  const t = useTranslations('ai.disclaimer');
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info aria-hidden="true" className="mt-px size-4 flex-none" />
      <span>{t('body')}</span>
    </p>
  );
}
