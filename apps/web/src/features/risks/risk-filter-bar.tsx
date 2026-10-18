'use client';

import {
  RISK_PHASES,
  RISK_PHASE_LABELS,
  RISK_STATUSES,
  RISK_STATUS_LABELS,
} from '@contrataflow/validation';
import type { RiskPhase, RiskStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { useRiskCategories } from './risks.api';
import type { RiskFilters } from './risks.api';
import { INPUT_CLASS } from '../processes/form-field';

export interface RiskFilterBarProps {
  readonly filters: RiskFilters;
  readonly onChange: (filters: RiskFilters) => void;
}

/**
 * `RiskFilterBar` (US-035 · fluxo principal 2): fase, categoria (`RISK_CATEGORY` ativas) e situação,
 * não persistidos — a matriz (RSK-09) recarrega sem trocar de tela. "Todas" = sem filtro.
 */
export function RiskFilterBar({ filters, onChange }: RiskFilterBarProps) {
  const t = useTranslations('risks.matrix.filters');
  const categories = useRiskCategories();
  const id = useId();
  const active =
    filters.phase !== undefined || filters.categoryId !== undefined || filters.status !== undefined;
  return (
    <fieldset className="flex min-w-0 flex-wrap items-end gap-3">
      <legend className="sr-only">{t('legend')}</legend>
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm" htmlFor={`${id}-phase`}>
        {t('phase')}
        <select
          id={`${id}-phase`}
          className={INPUT_CLASS}
          value={filters.phase ?? ''}
          onChange={(event) => {
            onChange({
              ...filters,
              phase: event.target.value === '' ? undefined : (event.target.value as RiskPhase),
            });
          }}
        >
          <option value="">{t('all')}</option>
          {RISK_PHASES.map((phase) => (
            <option key={phase} value={phase}>
              {RISK_PHASE_LABELS[phase]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm" htmlFor={`${id}-category`}>
        {t('category')}
        <select
          id={`${id}-category`}
          className={INPUT_CLASS}
          value={filters.categoryId ?? ''}
          disabled={categories.data === undefined}
          onChange={(event) => {
            onChange({
              ...filters,
              categoryId: event.target.value === '' ? undefined : event.target.value,
            });
          }}
        >
          <option value="">{t('all')}</option>
          {(categories.data ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm" htmlFor={`${id}-status`}>
        {t('status')}
        <select
          id={`${id}-status`}
          className={INPUT_CLASS}
          value={filters.status ?? ''}
          onChange={(event) => {
            onChange({
              ...filters,
              status: event.target.value === '' ? undefined : (event.target.value as RiskStatus),
            });
          }}
        >
          <option value="">{t('all')}</option>
          {RISK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {RISK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      {active ? (
        <button
          type="button"
          className="h-10 text-sm text-primary underline"
          onClick={() => {
            onChange({});
          }}
        >
          {t('clear')}
        </button>
      ) : null}
    </fieldset>
  );
}
