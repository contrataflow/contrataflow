'use client';

import { cx } from '@contrataflow/ui';
import type {
  OutlierFlag,
  PriceItemAlert,
  PriceItemAlertCode,
  PriceResearchParameters,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

/*
 * Selos de US-030 (SCR-009 · reaproveitados na SCR-010/US-031): `AlertBadgeList` por item e
 * `OutlierBadge`/`ExpiredBadge` por cotação. Sinalizam sem decidir (DEC-020): o texto diz o que
 * aconteceu, nunca só a cor (daltonismo e leitores de tela), e o motivo fica num tooltip que abre
 * também pelo teclado (foco). Sob POL-09 o selo continua visível, mas sem percentuais (FA-05).
 */

const BADGE = 'rounded-control border px-2 py-0.5 text-xs font-medium';
const WARNING = 'border-warning/30 bg-warning-soft';

/**
 * Selo com o motivo num `role="tooltip"` ligado por `aria-describedby`. O gatilho é um botão sem
 * ação (só para receber foco pelo teclado e abrir o tooltip — padrão de tooltip acessível).
 */
function BadgeWithTooltip({
  label,
  tooltip,
  className,
}: {
  readonly label: string;
  readonly tooltip: string;
  readonly className?: string;
}): ReactNode {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-describedby={id} className={cx(BADGE, className)}>
        {label}
      </button>
      <span
        id={id}
        role="tooltip"
        className={cx(
          'absolute top-full left-0 z-10 mt-1 hidden w-64 rounded-control border border-border',
          'bg-surface p-2 text-xs font-normal shadow-md group-focus-within:block group-hover:block',
        )}
      >
        {tooltip}
      </span>
    </span>
  );
}

/** `AlertBadgeList` (RN-PRICE-50): todos os alertas do item, sem priorização (FA-04). */
export function AlertBadgeList({
  alerts,
}: {
  readonly alerts: readonly PriceItemAlert[];
}): ReactNode {
  const t = useTranslations('priceResearch.items');
  if (alerts.length === 0) {
    return <span className="text-sm text-muted-foreground">{t('noAlerts')}</span>;
  }
  const labels: Record<PriceItemAlertCode, string> = {
    NO_VALID_QUOTES: t('alerts.NO_VALID_QUOTES'),
    BELOW_MINIMUM_QUOTES: t('alerts.BELOW_MINIMUM_QUOTES'),
    HIGH_CV: t('alerts.HIGH_CV'),
    HAS_OUTLIERS: t('alerts.HAS_OUTLIERS'),
    EXPIRED_QUOTES: t('alerts.EXPIRED_QUOTES'),
  };
  const hints: Record<PriceItemAlertCode, string> = {
    NO_VALID_QUOTES: t('alertHints.NO_VALID_QUOTES'),
    BELOW_MINIMUM_QUOTES: t('alertHints.BELOW_MINIMUM_QUOTES'),
    HIGH_CV: t('alertHints.HIGH_CV'),
    HAS_OUTLIERS: t('alertHints.HAS_OUTLIERS'),
    EXPIRED_QUOTES: t('alertHints.EXPIRED_QUOTES'),
  };
  return (
    <ul aria-label={t('alertsLabel')} className="flex flex-wrap gap-1">
      {alerts.map((alert) => (
        <li key={alert.code}>
          <BadgeWithTooltip
            label={labels[alert.code]}
            tooltip={hints[alert.code]}
            className={WARNING}
          />
        </li>
      ))}
    </ul>
  );
}

/** Percentual do snapshot sem zeros à direita (`"70.0000"` → `70`). */
const percent = (value: string) =>
  new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(Number(value));

/**
 * `OutlierBadge` (RN-PRICE-48): "Abaixo/Acima da mediana" com o limiar comparado no tooltip; sem
 * POL-09 (`masked`), o tooltip só explica o motivo. Nada para `NONE`.
 */
export function OutlierBadge({
  flag,
  parameters,
  masked,
}: {
  readonly flag: OutlierFlag;
  readonly parameters: Pick<PriceResearchParameters, 'outlierLowerPercent' | 'outlierUpperPercent'>;
  readonly masked: boolean;
}): ReactNode {
  const t = useTranslations('priceResearch.sources.grid');
  if (flag === 'NONE') return null;
  const low = flag === 'LOW';
  let tooltip: string;
  if (masked) tooltip = t(low ? 'outlierLowMasked' : 'outlierHighMasked');
  else if (low) tooltip = t('outlierLowHint', { percent: percent(parameters.outlierLowerPercent) });
  else tooltip = t('outlierHighHint', { percent: percent(parameters.outlierUpperPercent) });
  return (
    <BadgeWithTooltip
      label={t(low ? 'outlierLow' : 'outlierHigh')}
      tooltip={tooltip}
      className={WARNING}
    />
  );
}

/** `ExpiredBadge` (RN-PRICE-49): cotação vencida pela validade do tipo de fonte. */
export function ExpiredBadge({ isExpired }: { readonly isExpired: boolean }): ReactNode {
  const t = useTranslations('priceResearch.sources.grid');
  if (!isExpired) return null;
  return <BadgeWithTooltip label={t('expired')} tooltip={t('expiredHint')} className={WARNING} />;
}
