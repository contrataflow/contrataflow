'use client';

import { InfoTooltip, StatusChip } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/**
 * `SystemTemplateBadge` (US-110 · SCR-033/SCR-114): selo dos templates semeados pela biblioteca
 * padrão (`isSystem`). Só indica a origem — o template continua editável (RN-TPL-32) — e é expresso
 * em texto, não só por cor; a explicação fica no `InfoTooltip`.
 */
export function SystemTemplateBadge() {
  const t = useTranslations('templates');
  return (
    <span className="inline-flex items-center gap-0.5">
      <StatusChip>{t('badges.system')}</StatusChip>
      <InfoTooltip label={t('help', { field: t('badges.system') })}>
        {t('badges.systemHint')}
      </InfoTooltip>
    </span>
  );
}
