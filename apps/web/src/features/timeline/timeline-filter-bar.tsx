'use client';

import { TIMELINE_GROUPS } from '@contrataflow/types';
import type { TimelineGroup } from '@contrataflow/types';
import {
  Checkbox,
  DatePicker,
  Field,
  FilterToolbar,
  Label,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { EMPTY_TIMELINE_FILTERS, isPeriodInverted } from './timeline-model';
import type { ActorOption, TimelineFilters } from './timeline-model';

function toggle<T>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...values, value] : values.filter((item) => item !== value);
}

export interface TimelineFilterBarProps {
  readonly filters: TimelineFilters;
  readonly actors: readonly ActorOption[];
  /** Chamado a cada mudança válida (V-01: período invertido não é aplicado). */
  readonly onChange: (filters: TimelineFilters) => void;
}

/**
 * `TimelineFilterBar` (SCR-006 · US-060) na `FilterToolbar` do kit: o botão "Filtros" abre um
 * popover com grupo, autor (atores já presentes na timeline — RN-TML-11) e período em datas locais
 * do tenant; o que está ativo aparece em chips removíveis. Período invertido marca o campo e não é
 * enviado (V-01).
 */
export function TimelineFilterBar({ filters, actors, onChange }: TimelineFilterBarProps) {
  const t = useTranslations('timeline.filters');
  const tGroups = useTranslations('timeline.groups');
  const format = useFormatter();
  const id = useId();
  const [period, setPeriod] = useState({ from: filters.from, to: filters.to });
  const inverted = isPeriodInverted(period);

  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short', timeZone: 'UTC' });

  const changePeriod = (next: { from: string; to: string }) => {
    setPeriod(next);
    if (!isPeriodInverted(next)) onChange({ ...filters, ...next });
  };

  const chips: FilterToolbarChip[] = [];
  const addChip = (key: string, label: string, value: string, onRemove: () => void) => {
    chips.push({
      id: key,
      label: t('chip', { label, value }),
      removeLabel: t('remove', { label: `${label}: ${value}` }),
      onRemove,
    });
  };
  for (const group of filters.groups) {
    addChip(`group-${group}`, t('group'), tGroups(group), () => {
      onChange({ ...filters, groups: toggle(filters.groups, group, false) });
    });
  }
  for (const actorId of filters.actorIds) {
    const name = actors.find((actor) => actor.id === actorId)?.name ?? '…';
    addChip(`actor-${actorId}`, t('actor'), name, () => {
      onChange({ ...filters, actorIds: toggle(filters.actorIds, actorId, false) });
    });
  }
  if (filters.from !== '' || filters.to !== '') {
    const value =
      filters.from !== '' && filters.to !== ''
        ? t('periodRange', { from: date(filters.from), to: date(filters.to) })
        : filters.from !== ''
          ? t('periodFrom', { date: date(filters.from) })
          : t('periodTo', { date: date(filters.to) });
    addChip('period', t('period'), value, () => {
      setPeriod({ from: '', to: '' });
      onChange({ ...filters, from: '', to: '' });
    });
  }

  return (
    <FilterToolbar
      filters={
        <>
          <Field label={t('group')} group>
            <div className="flex flex-col gap-2">
              {TIMELINE_GROUPS.map((group: TimelineGroup) => (
                <div key={group} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-group-${group}`}
                    checked={filters.groups.includes(group)}
                    onCheckedChange={(checked) => {
                      onChange({
                        ...filters,
                        groups: toggle(filters.groups, group, checked === true),
                      });
                    }}
                  />
                  <Label htmlFor={`${id}-group-${group}`} className="font-normal">
                    {tGroups(group)}
                  </Label>
                </div>
              ))}
            </div>
          </Field>
          <Field label={t('actor')} group>
            {actors.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noActors')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {actors.map((actor) => (
                  <div key={actor.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-actor-${actor.id}`}
                      checked={filters.actorIds.includes(actor.id)}
                      onCheckedChange={(checked) => {
                        onChange({
                          ...filters,
                          actorIds: toggle(filters.actorIds, actor.id, checked === true),
                        });
                      }}
                    />
                    <Label htmlFor={`${id}-actor-${actor.id}`} className="font-normal">
                      {actor.name}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </Field>
          <Field label={t('from')}>
            <DatePicker
              clearable
              value={fromIsoDate(period.from)}
              onValueChange={(value) => {
                changePeriod({ ...period, from: value ? toIsoDate(value) : '' });
              }}
              labels={{
                placeholder: t('datePlaceholder'),
                clear: t('dateClear', { label: t('from') }),
                calendar: t('dateCalendar', { label: t('from') }),
              }}
            />
          </Field>
          <Field label={t('to')} error={inverted ? t('periodInverted') : undefined}>
            <DatePicker
              clearable
              value={fromIsoDate(period.to)}
              onValueChange={(value) => {
                changePeriod({ ...period, to: value ? toIsoDate(value) : '' });
              }}
              labels={{
                placeholder: t('datePlaceholder'),
                clear: t('dateClear', { label: t('to') }),
                calendar: t('dateCalendar', { label: t('to') }),
              }}
            />
          </Field>
        </>
      }
      activeCount={chips.length}
      chips={chips}
      onClearAll={() => {
        setPeriod({ from: '', to: '' });
        onChange(EMPTY_TIMELINE_FILTERS);
      }}
      labels={{
        filters: t('open'),
        clearAll: t('clear'),
        activeFilters: t('active'),
      }}
    />
  );
}
