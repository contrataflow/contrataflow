'use client';

import { useTranslations } from 'next-intl';

/**
 * `SystemTemplateBadge` (US-110 · SCR-033/SCR-114): selo dos templates semeados pela biblioteca
 * padrão (`isSystem`). Só indica a origem — o template continua editável (RN-TPL-32) — e é expresso
 * em texto, não só por cor.
 */
export function SystemTemplateBadge() {
  const t = useTranslations('templates');
  return (
    <span
      className="inline-flex rounded-control bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      title={t('badges.systemHint')}
    >
      {t('badges.system')}
    </span>
  );
}
