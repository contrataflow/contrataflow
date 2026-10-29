'use client';

import {
  Checkbox,
  DatePicker,
  Field,
  FilterToolbar,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
import { MOVEMENT_ACTIONS } from '@contrataflow/validation';
import type { MovementAction } from '@contrataflow/validation';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { EMPTY_MOVEMENT_FILTERS, isMovementPeriodInverted } from './movements-model';
import type { MovementFilterOptions, MovementFilters } from './movements-model';

/** "Todas/Todos" nos `Select` (o Radix não aceita valor vazio). */
const ANY = '__any__';

type PartyField = 'fromDepartmentId' | 'toDepartmentId' | 'actorId';

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
 * `MovementFilterBar` (SCR-006 · US-054 · FA-01) na `FilterToolbar` do kit: o botão "Filtros" abre
 * um popover com ação (várias, OU), unidade de origem e de destino, ator (as já vistas no histórico
 * carregado) e período em datas locais do tenant, combinados por E; o que está ativo aparece em
 * chips removíveis. Período invertido marca o campo e não é enviado (V-02).
 */
export function MovementFilterBar({ filters, options, onChange }: MovementFilterBarProps) {
  const t = useTranslations('movements.filters');
  const tActions = useTranslations('movements.actions');
  const format = useFormatter();
  const id = useId();
  const [period, setPeriod] = useState({ from: filters.from, to: filters.to });
  const inverted = isMovementPeriodInverted(period);

  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short', timeZone: 'UTC' });

  const changePeriod = (next: { from: string; to: string }) => {
    setPeriod(next);
    if (!isMovementPeriodInverted(next)) onChange({ ...filters, ...next });
  };

  const choicesOf = (field: PartyField) =>
    field === 'actorId' ? options.actors : options.departments;
  const nameOf = (field: PartyField, value: string) =>
    choicesOf(field).find((choice) => choice.id === value)?.name ?? '…';
  const labelOf: Readonly<Record<PartyField, string>> = {
    fromDepartmentId: t('fromDepartment'),
    toDepartmentId: t('toDepartment'),
    actorId: t('actor'),
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
  for (const action of filters.actions) {
    addChip(`action-${action}`, t('action'), tActions(action), () => {
      onChange({ ...filters, actions: toggle(filters.actions, action, false) });
    });
  }
  for (const field of ['fromDepartmentId', 'toDepartmentId', 'actorId'] as const) {
    if (filters[field] === '') continue;
    addChip(field, labelOf[field], nameOf(field, filters[field]), () => {
      onChange({ ...filters, [field]: '' });
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

  const partyField = (field: PartyField, any: string) => (
    <Field label={labelOf[field]}>
      <Select
        value={filters[field] === '' ? ANY : filters[field]}
        onValueChange={(value) => {
          onChange({ ...filters, [field]: value === ANY ? '' : value });
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{any}</SelectItem>
          {choicesOf(field).map((choice) => (
            <SelectItem key={choice.id} value={choice.id}>
              {choice.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );

  return (
    <FilterToolbar
      filters={
        <>
          <Field label={t('action')} group>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {MOVEMENT_ACTIONS.map((action: MovementAction) => (
                <div key={action} className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-${action}`}
                    checked={filters.actions.includes(action)}
                    onCheckedChange={(checked) => {
                      onChange({
                        ...filters,
                        actions: toggle(filters.actions, action, checked === true),
                      });
                    }}
                  />
                  <Label htmlFor={`${id}-${action}`} className="font-normal">
                    {tActions(action)}
                  </Label>
                </div>
              ))}
            </div>
          </Field>
          {partyField('fromDepartmentId', t('any'))}
          {partyField('toDepartmentId', t('any'))}
          {partyField('actorId', t('anyActor'))}
          {options.departments.length === 0 && options.actors.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('optionsHint')}</p>
          ) : null}
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
        onChange(EMPTY_MOVEMENT_FILTERS);
      }}
      labels={{
        filters: t('open'),
        clearAll: t('clear'),
        activeFilters: t('active'),
      }}
    />
  );
}
