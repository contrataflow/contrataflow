'use client';

import { Alert } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/** `AiDisclaimer` (SCR-117 · DEC-037): aviso fixo de que o conteúdo gerado precisa de revisão. */
export function AiDisclaimer() {
  const t = useTranslations('ai.disclaimer');
  return (
    <Alert tone="info" live={false} title={t('title')}>
      <p>{t('body')}</p>
    </Alert>
  );
}
