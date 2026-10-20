'use client';

import { TIMELINE_GROUPS } from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import { Button, cx } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { hasActiveFilters, isPeriodInverted } from './timeline-model';
import type { ActorOption, TimelineFilters } from './timeline-model';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

function toggle<T>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...values, value] : values.filter((item) => item !== value);
}

function activeCount(filters: TimelineFilters): number {
  return (
    filters.groups.length +
    filters.actorIds.length +
    (filters.from === '' ? 0 : 1) +
    (filters.to === '' ? 0 : 1)
  );
}

export interface TimelineFilterBarProps {
  readonly filters: TimelineFilters;
  readonly actors: readonly ActorOption[];
  /** Chamado a cada mudança válida (V-01: período invertido não é aplicado). */
  readonly onChange: (filters: TimelineFilters) => void;
}

/**
 * `TimelineFilterBar` (SCR-006 · US-060): grupo, autor (atores já presentes na timeline —
 * RN-TML-11) e período em datas locais do tenant. Período invertido marca os campos e não é
 * enviado (V-01). Abaixo de 768 px vira painel colapsável. Navegável por teclado (controles
 * nativos em `fieldset`/`legend`).
 */
export function TimelineFilterBar({ filters, actors, onChange }: TimelineFilterBarProps) {
  const t = useTranslations('timeline.filters');
  const tGroups = useTranslations('timeline.groups');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState({ from: filters.from, to: filters.to });
  const inverted = isPeriodInverted(period);
  const panelId = `${id}-panel`;
  const errorId = `${id}-period-error`;
  const count = activeCount(filters);

  const changePeriod = (next: { from: string; to: string }) => {
    setPeriod(next);
    if (!isPeriodInverted(next)) onChange({ ...filters, ...next });
  };

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
          <legend className="mb-1 text-sm font-medium">{t('group')}</legend>
          {TIMELINE_GROUPS.map((group: TimelineGroup) => (
            <label key={group} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={filters.groups.includes(group)}
                onChange={(event) => {
                  onChange({
                    ...filters,
                    groups: toggle(filters.groups, group, event.target.checked),
                  });
                }}
              />
              {tGroups(group)}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('actor')}</legend>
          {actors.length === 0 ? (
            <p className="max-w-56 text-xs text-muted-foreground">{t('noActors')}</p>
          ) : (
            actors.map((actor) => (
              <label key={actor.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={filters.actorIds.includes(actor.id)}
                  onChange={(event) => {
                    onChange({
                      ...filters,
                      actorIds: toggle(filters.actorIds, actor.id, event.target.checked),
                    });
                  }}
                />
                {actor.name}
              </label>
            ))
          )}
        </fieldset>

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

        {hasActiveFilters(filters) || period.from !== '' || period.to !== '' ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              setPeriod({ from: '', to: '' });
              onChange({ groups: [], actorIds: [], from: '', to: '' });
            }}
          >
            {t('clear')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
