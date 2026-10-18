'use client';

import { PRICE_RESEARCH_MESSAGES } from '@contrataflow/validation';
import type { PriceResearchParameters } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { formatDate } from '@/lib/i18n/format';

const percentFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

/**
 * `ParametersPanel` (US-024 · FA-06): o snapshot dos parâmetros `priceResearch.*` fixado na criação
 * (RN-PRICE-05), somente leitura, com a nota de que mudanças posteriores nas configurações não
 * afetam esta pesquisa.
 */
export function ParametersPanel({
  parameters,
  createdAt,
  timeZone,
}: {
  readonly parameters: PriceResearchParameters;
  readonly createdAt: string;
  readonly timeZone: string;
}) {
  const t = useTranslations('priceResearch.parameters');
  const percent = (value: string) => t('percent', { value: percentFormat.format(Number(value)) });
  const percentOfMedian = (value: string) =>
    t('percentOfMedian', { value: percentFormat.format(Number(value)) });
  const entries: readonly (readonly [string, string])[] = [
    [t('defaultMethod'), t(`methods.${parameters.defaultMethod}`)],
    [t('cvThreshold'), percent(parameters.cvThresholdPercent)],
    [t('minQuotations'), String(parameters.minQuotations)],
    [t('directQuoteMaxAgeDays'), t('days', { count: parameters.directQuoteMaxAgeDays })],
    [t('similarContractMaxAgeDays'), t('days', { count: parameters.similarContractMaxAgeDays })],
    [t('outlierLower'), percentOfMedian(parameters.outlierLowerPercent)],
    [t('outlierUpper'), percentOfMedian(parameters.outlierUpperPercent)],
    [t('unitPriceDecimals'), String(parameters.unitPriceDecimals)],
    [t('roundingMode'), t(`roundingModes.${parameters.roundingMode}`)],
  ];
  return (
    <aside
      aria-labelledby="pr-parameters-title"
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <h2 id="pr-parameters-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      <dl className="flex flex-col gap-2 text-sm">
        {entries.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {PRICE_RESEARCH_MESSAGES.parametersNote(formatDate(createdAt, timeZone))}
      </p>
    </aside>
  );
}
