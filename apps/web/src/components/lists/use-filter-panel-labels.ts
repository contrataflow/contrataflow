'use client';

import type { FilterPanelLabels } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/**
 * Textos do `FilterPanel` (prd-6 §2.4) a partir de `shell.listFilters`: as listas passam o
 * resultado em `labels` e só sobrescrevem o nome da região quando precisam distinguir a tela.
 */
export function useFilterPanelLabels(): FilterPanelLabels {
  const t = useTranslations('shell.listFilters');
  return {
    region: t('region'),
    toggle: (count) => t('toggle', { count }),
    more: t('more'),
    moreCount: (count) => t('moreCount', { count }),
    clear: t('clear'),
  };
}
