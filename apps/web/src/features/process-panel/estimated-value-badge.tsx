'use client';

import type { EstimatedValueSource } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { ConfidentialValue } from '../process-list/process-list-badges';

/**
 * `EstimatedValueBadge` (US-017 · screens.md): o valor estimado do processo (mascarado — POL-09 —
 * por `ConfidentialValue`) e a origem (DEC-032: "Origem: DFD", "Origem: Pesquisa de preços"…).
 */
export function EstimatedValueBadge({
  value,
  masked,
  source,
}: {
  readonly value: string | null;
  readonly masked: boolean;
  readonly source: EstimatedValueSource | null;
}) {
  const t = useTranslations('processes.panel.header');
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <ConfidentialValue value={value} masked={masked} />
      {source ? (
        <span className="text-xs text-muted-foreground">
          {t('valueSource', { source: t(`sources.${source}`) })}
        </span>
      ) : null}
    </span>
  );
}
