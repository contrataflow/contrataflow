'use client';

import { useTranslations } from 'next-intl';

import type { TreatmentDueState } from './treatments-model';

const TONE: Readonly<Record<TreatmentDueState['kind'], string>> = {
  overdue: 'bg-destructive-soft text-destructive',
  today: 'bg-warning-soft text-warning',
  soon: 'bg-warning-soft text-warning',
};

/**
 * `OverdueBadge` (US-034 · FA-03): "Atrasado", "Vence hoje" ou "Vence em N dias", calculado em
 * runtime (sem campo persistido). O texto vai sempre junto da cor (acessibilidade).
 */
export function OverdueBadge({ state }: { readonly state: TreatmentDueState | null }) {
  const t = useTranslations('risks.treatments.due');
  if (state === null) return null;
  const text =
    state.kind === 'overdue'
      ? t('overdue')
      : state.kind === 'today'
        ? t('today')
        : t('soon', { days: state.days });
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${TONE[state.kind]}`}
    >
      {text}
    </span>
  );
}
