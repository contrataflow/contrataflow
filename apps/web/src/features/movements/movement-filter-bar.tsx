'use client';

import { Button, cx } from '@contrataflow/ui';
import { MOVEMENT_ACTIONS } from '@contrataflow/validation';
import type { MovementAction } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import {
  EMPTY_MOVEMENT_FILTERS,
  activeFilterCount,
  isMovementPeriodInverted,
} from './movements-model';
import type { MovementFilterOptions, MovementFilters } from './movements-model';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

function toggle<T>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...values, value] : values.filter((item) => item !== value);
}

export interface MovementFilterBarProps {
  readonly filters: MovementFilters;
  readonly options: MovementFilterOptions;
  /** Chamado a cada mudança válida (V-02: período invertido não é aplicado). */
  readonly onChange: (filters: MovementFilters) => void;
}

/**
 * `MovementFilterBar` (SCR-006 · US-054 · FA-01): ação (várias, OU), unidade de origem e de
 * destino e ator (as já vistas no histórico carregado) e período em datas locais do tenant,
 * combinados por E. Período invertido marca os campos e não é enviado (V-02). Abaixo de 768 px vira
 * painel colapsável. Navegável por teclado (controles nativos em `fieldset`/`legend`).
 */
export function MovementFilterBar({ filters, options, onChange }: MovementFilterBarProps) {
  const t = useTranslations('movements.filters');
  const tActions = useTranslations('movements.actions');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState({ from: filters.from, to: filters.to });
  const inverted = isMovementPeriodInverted(period);
  const panelId = `${id}-panel`;
  const errorId = `${id}-period-error`;
  const count = activeFilterCount(filters);

  const changePeriod = (next: { from: string; to: string }) => {
    setPeriod(next);
    if (!isMovementPeriodInverted(next)) onChange({ ...filters, ...next });
  };

  const select = (
    field: 'fromDepartmentId' | 'toDepartmentId' | 'actorId',
    label: string,
    choices: MovementFilterOptions['departments'],
    any: string,
  ) => (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-${field}`} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={`${id}-${field}`}
        className={cx(INPUT, 'max-w-64')}
        value={filters[field]}
        onChange={(event) => {
          onChange({ ...filters, [field]: event.target.value });
        }}
      >
        <option value="">{any}</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section aria-label={t('label')} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 md:hidden">
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {count > 0 ? t('toggleActive', { count }) : t('toggle')}
        </Button>
      </div>
      <div
        id={panelId}
        className={cx(
          'flex-col gap-4 rounded-card border border-border bg-surface p-4 md:flex md:flex-row md:flex-wrap md:items-start',
          open ? 'flex' : 'hidden',
        )}
      >
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('action')}</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {MOVEMENT_ACTIONS.map((action: MovementAction) => (
              <label key={action} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={filters.actions.includes(action)}
                  onChange={(event) => {
                    onChange({
                      ...filters,
                      actions: toggle(filters.actions, action, event.target.checked),
                    });
                  }}
                />
                {tActions(action)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex min-w-0 flex-col gap-3">
          {select('fromDepartmentId', t('fromDepartment'), options.departments, t('any'))}
          {select('toDepartmentId', t('toDepartment'), options.departments, t('any'))}
          {select('actorId', t('actor'), options.actors, t('anyActor'))}
          {options.departments.length === 0 && options.actors.length === 0 ? (
            <p className="max-w-64 text-xs text-muted-foreground">{t('optionsHint')}</p>
          ) : null}
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('period')}</legend>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-from`} className="text-sm">
                {t('from')}
              </label>
              <input
                id={`${id}-from`}
                type="date"
                className={INPUT}
                value={period.from}
                aria-invalid={inverted ? true : undefined}
                aria-describedby={inverted ? errorId : undefined}
                onChange={(event) => {
                  changePeriod({ ...period, from: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-to`} className="text-sm">
                {t('to')}
              </label>
              <input
                id={`${id}-to`}
                type="date"
                className={INPUT}
                value={period.to}
                aria-invalid={inverted ? true : undefined}
                aria-describedby={inverted ? errorId : undefined}
                onChange={(event) => {
                  changePeriod({ ...period, to: event.target.value });
                }}
              />
            </div>
          </div>
          {inverted ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {t('periodInverted')}
            </p>
          ) : null}
        </fieldset>

        {count > 0 || period.from !== '' || period.to !== '' ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              setPeriod({ from: '', to: '' });
              onChange(EMPTY_MOVEMENT_FILTERS);
            }}
          >
            {t('clear')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
