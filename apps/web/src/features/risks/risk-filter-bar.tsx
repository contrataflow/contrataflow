'use client';

import {
  Button,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contrataflow/ui';
import {
  RISK_PHASES,
  RISK_PHASE_LABELS,
  RISK_STATUSES,
  RISK_STATUS_LABELS,
} from '@contrataflow/validation';
import type { RiskPhase, RiskStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { useRiskCategories } from './risks.api';
import type { RiskFilters } from './risks.api';

const ALL = '__all__';

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
  const active =
    filters.phase !== undefined || filters.categoryId !== undefined || filters.status !== undefined;
  return (
    <fieldset className="flex min-w-0 flex-wrap items-end gap-3">
      <legend className="sr-only">{t('legend')}</legend>
      <Field label={t('phase')} className="min-w-40 flex-1">
        <Select
          value={filters.phase ?? ALL}
          onValueChange={(value) => {
            onChange({ ...filters, phase: value === ALL ? undefined : (value as RiskPhase) });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('all')}</SelectItem>
            {RISK_PHASES.map((phase) => (
              <SelectItem key={phase} value={phase}>
                {RISK_PHASE_LABELS[phase]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('category')} className="min-w-40 flex-1">
        <Select
          value={filters.categoryId ?? ALL}
          disabled={categories.data === undefined}
          onValueChange={(value) => {
            onChange({ ...filters, categoryId: value === ALL ? undefined : value });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('all')}</SelectItem>
            {(categories.data ?? []).map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('status')} className="min-w-40 flex-1">
        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) => {
            onChange({ ...filters, status: value === ALL ? undefined : (value as RiskStatus) });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('all')}</SelectItem>
            {RISK_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {RISK_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {active ? (
        <Button
          variant="ghost"
          onClick={() => {
            onChange({});
          }}
        >
          {t('clear')}
        </Button>
      ) : null}
    </fieldset>
  );
}
