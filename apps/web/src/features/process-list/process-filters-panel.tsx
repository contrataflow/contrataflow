'use client';

import { Button, Dialog, DialogContent, DialogFooter, DialogTitle } from '@contrataflow/ui';
import { PRIORITIES, PROCESS_STATUSES } from '@contrataflow/validation';
import type {
  CatalogItemDto,
  ProcessListParamKey,
  ProcessStageOptionDto,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { formatMoneyText, toDecimalMoney } from '@/features/processes/money';

import { valuesOf } from './process-list-state';
import type { ListParams } from './process-list-state';
import type { UnitOption } from './process-list.api';

/*
 * `ProcessFiltersPanel` (SCR-004 · US-002): formulário rotulado com os filtros da tabela "Campos".
 * Painel lateral no desktop e inferior no mobile (FA-09); "Aplicar" grava na URL e volta à página
 * 1; o foco volta ao gatilho ao fechar (Radix). Intervalos invertidos e valores inválidos são
 * recusados aqui (V-06/V-07) antes de irem para a URL.
 */

export interface FilterOptions {
  readonly stages: readonly ProcessStageOptionDto[];
  readonly units: readonly UnitOption[];
  readonly organizations: readonly { readonly id: string; readonly name: string }[];
  readonly contractingTypes: readonly CatalogItemDto[];
  readonly modalities: readonly CatalogItemDto[];
  readonly origins: readonly CatalogItemDto[];
}

export type FilterDraft = Partial<Record<ProcessListParamKey, string | undefined>>;
type Draft = FilterDraft;

const FILTER_KEYS: readonly ProcessListParamKey[] = [
  'status',
  'priority',
  'stageKey',
  'currentDepartmentId',
  'requestingSecretariatId',
  'requestingDepartmentId',
  'organizationId',
  'currentResponsibleId',
  'contractingTypeId',
  'modalityId',
  'originId',
  'year',
  'overdue',
  'targetDateOverdue',
  'createdFrom',
  'createdTo',
  'targetDateFrom',
  'targetDateTo',
];

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

const inputClass = 'h-11 rounded-control border border-border bg-surface px-3 text-sm md:h-9';

function Checkboxes({
  legend,
  options,
  selected,
  onChange,
}: {
  readonly legend: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly selected: readonly string[];
  readonly onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value),
                );
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ProcessFiltersPanel({
  open,
  onOpenChange,
  params,
  options,
  onApply,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly params: ListParams;
  readonly options: FilterOptions;
  readonly onApply: (changes: Draft) => void;
}) {
  const t = useTranslations('processList.filters');
  const tStatus = useTranslations('processes.statuses');
  const tPriority = useTranslations('processes.priorities');
  const [draft, setDraft] = useState<Draft>(() => pick(params));
  const [minText, setMinText] = useState(() => moneyText(params.estimatedValueMin));
  const [maxText, setMaxText] = useState(() => moneyText(params.estimatedValueMax));
  const [error, setError] = useState<string | null>(null);

  const set = (key: ProcessListParamKey, value: string | undefined) => {
    setDraft((current) => ({ ...current, [key]: value === '' ? undefined : value }));
  };
  const single = (key: ProcessListParamKey) => {
    const values = valuesOf(draft[key]);
    return values.length === 1 ? (values[0] ?? '') : '';
  };

  const apply = () => {
    const min = minText.trim() === '' ? undefined : toDecimalMoney(minText);
    const max = maxText.trim() === '' ? undefined : toDecimalMoney(maxText);
    if (min === null || max === null || (min && max && Number(min) > Number(max))) {
      setError(t('invalidValue'));
      return;
    }
    for (const [from, to] of [
      [draft.createdFrom, draft.createdTo],
      [draft.targetDateFrom, draft.targetDateTo],
    ] as const) {
      if (from && to && from > to) {
        setError(t('invalidRange'));
        return;
      }
    }
    setError(null);
    onApply({ ...draft, estimatedValueMin: min, estimatedValueMax: max });
    onOpenChange(false);
  };

  const select = (
    key: ProcessListParamKey,
    label: string,
    choices: readonly { readonly value: string; readonly label: string }[],
  ) => (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          className={inputClass}
          value={single(key)}
          onChange={(event) => {
            set(key, event.target.value);
          }}
        >
          <option value="">{t('any')}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  const units = options.units.map((unit) => ({ value: unit.id, label: unit.name }));
  const catalog = (items: readonly CatalogItemDto[]) =>
    items.map((item) => ({ value: item.id, label: item.label }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('close')}
        className="max-h-[90vh] overflow-y-auto max-md:top-auto max-md:bottom-0 max-md:w-full max-md:max-w-none max-md:translate-y-0 max-md:rounded-b-none md:max-w-xl"
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <form
          aria-label={t('title')}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Checkboxes
            legend={t('status')}
            options={PROCESS_STATUSES.map((status) => ({ value: status, label: tStatus(status) }))}
            selected={valuesOf(draft.status)}
            onChange={(values) => {
              set('status', values.join(','));
            }}
          />
          <Checkboxes
            legend={t('priority')}
            options={PRIORITIES.map((priority) => ({
              value: priority,
              label: tPriority(priority),
            }))}
            selected={valuesOf(draft.priority)}
            onChange={(values) => {
              set('priority', values.join(','));
            }}
          />
          {options.stages.length > 0 ? (
            <Checkboxes
              legend={t('stage')}
              options={options.stages.map((stage) => ({ value: stage.key, label: stage.name }))}
              selected={valuesOf(draft.stageKey)}
              onChange={(values) => {
                set('stageKey', values.join(','));
              }}
            />
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {select('currentDepartmentId', t('currentDepartment'), [
              { value: 'mine', label: t('mine') },
              ...units,
            ])}
            {select('currentResponsibleId', t('responsible'), [
              { value: 'me', label: t('responsibleMe') },
              { value: 'none', label: t('responsibleNone') },
            ])}
            {select('requestingSecretariatId', t('requestingSecretariat'), units)}
            {select('requestingDepartmentId', t('requestingDepartment'), units)}
            {options.organizations.length > 1
              ? select(
                  'organizationId',
                  t('organization'),
                  options.organizations.map((org) => ({ value: org.id, label: org.name })),
                )
              : null}
            {select('contractingTypeId', t('contractingType'), catalog(options.contractingTypes))}
            {select('modalityId', t('modality'), [
              { value: 'none', label: t('modalityNone') },
              ...catalog(options.modalities),
            ])}
            {select('originId', t('origin'), catalog(options.origins))}
            <Field label={t('year')}>
              {(id) => (
                <input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={2000}
                  max={2100}
                  className={inputClass}
                  value={single('year')}
                  onChange={(event) => {
                    set('year', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-col gap-1">
            {(['overdue', 'targetDateOverdue'] as const).map((key) => (
              <label key={key} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                <input
                  type="checkbox"
                  checked={draft[key] === 'true'}
                  onChange={(event) => {
                    set(key, event.target.checked ? 'true' : undefined);
                  }}
                />
                {t(key)}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['createdFrom', 'createdTo', 'targetDateFrom', 'targetDateTo'] as const).map(
              (key) => (
                <Field key={key} label={t(key)}>
                  {(id) => (
                    <input
                      id={id}
                      type="date"
                      className={inputClass}
                      value={draft[key] ?? ''}
                      onChange={(event) => {
                        set(key, event.target.value);
                      }}
                    />
                  )}
                </Field>
              ),
            )}
            <Field label={t('estimatedValueMin')}>
              {(id) => (
                <input
                  id={id}
                  inputMode="decimal"
                  placeholder={t('valueHint')}
                  className={inputClass}
                  value={minText}
                  onChange={(event) => {
                    setMinText(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('estimatedValueMax')}>
              {(id) => (
                <input
                  id={id}
                  inputMode="decimal"
                  placeholder={t('valueHint')}
                  className={inputClass}
                  value={maxText}
                  onChange={(event) => {
                    setMaxText(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <div aria-live="polite">
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit">{t('apply')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function pick(params: ListParams): Draft {
  const draft: Draft = {};
  for (const key of FILTER_KEYS) if (params[key] !== undefined) draft[key] = params[key];
  return draft;
}

function moneyText(decimal: string | undefined): string {
  return decimal === undefined ? '' : formatMoneyText(decimal);
}
