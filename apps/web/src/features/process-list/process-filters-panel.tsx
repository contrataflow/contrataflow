'use client';

import {
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import { PRIORITIES, PROCESS_STATUSES } from '@contrataflow/validation';
import type {
  CatalogItemDto,
  ProcessListParamKey,
  ProcessStageOptionDto,
  TagDto,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { formatMoneyText, toDecimalMoney } from '@/features/processes/money';

import { valuesOf } from './process-list-state';
import type { ListParams } from './process-list-state';
import type { UnitOption } from './process-list.api';

/*
 * `ProcessFiltersPanel` (SCR-004 · US-002): formulário rotulado com os filtros da tabela "Campos".
 * Diálogo do kit (folha inferior no mobile, FA-09) com os controles do kit (`Select`, `Checkbox`,
 * `DatePicker`); "Aplicar" grava na URL e volta à página 1; o foco volta ao gatilho ao fechar (Radix). Intervalos invertidos e valores inválidos são
 * recusados aqui (V-06/V-07) antes de irem para a URL.
 */

export interface FilterOptions {
  readonly stages: readonly ProcessStageOptionDto[];
  readonly units: readonly UnitOption[];
  readonly organizations: readonly { readonly id: string; readonly name: string }[];
  readonly contractingTypes: readonly CatalogItemDto[];
  readonly modalities: readonly CatalogItemDto[];
  readonly origins: readonly CatalogItemDto[];
  /** US-007: etiquetas do cadastro (as inativas só chegam a quem tem `TAG_MANAGE`). */
  readonly tags: readonly TagDto[];
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
  'tagId',
  'year',
  'overdue',
  'targetDateOverdue',
  'createdFrom',
  'createdTo',
  'targetDateFrom',
  'targetDateTo',
];

/** "Qualquer" nos `Select` (o Radix não aceita valor vazio). */
const ANY = 'any';

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
  const id = useId();
  return (
    <Field group label={legend}>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {options.map((option) => {
          const optionId = `${id}-${option.value}`;
          return (
            <div key={option.value} className="flex min-h-9 items-center gap-2">
              <Checkbox
                id={optionId}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => {
                  onChange(
                    checked === true
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value),
                  );
                }}
              />
              <Label htmlFor={optionId} className="font-normal">
                {option.label}
              </Label>
            </div>
          );
        })}
      </div>
    </Field>
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
  const tTags = useTranslations('tags.filter');
  const [draft, setDraft] = useState<Draft>(() => pick(params));
  const [minText, setMinText] = useState(() => moneyText(params.estimatedValueMin));
  const [maxText, setMaxText] = useState(() => moneyText(params.estimatedValueMax));
  const [error, setError] = useState<string | null>(null);
  const flagsId = useId();

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
      <Select
        value={single(key) || ANY}
        onValueChange={(value) => {
          set(key, value === ANY ? undefined : value);
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t('any')}</SelectItem>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  const units = options.units.map((unit) => ({ value: unit.id, label: unit.name }));
  /** Cada grupo troca só as próprias etiquetas: as marcadas no outro grupo são preservadas. */
  const mergeTags = (group: readonly TagDto[], values: readonly string[]) => {
    const others = valuesOf(draft.tagId).filter((id) => !group.some((tag) => tag.id === id));
    set('tagId', [...others, ...values].join(','));
  };
  const activeTags = options.tags.filter((tag) => tag.isActive);
  const inactiveTags = options.tags.filter((tag) => !tag.isActive);
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
          {activeTags.length > 0 ? (
            <Checkboxes
              legend={tTags('legend')}
              options={activeTags.map((tag) => ({ value: tag.id, label: tag.name }))}
              selected={valuesOf(draft.tagId).filter((id) =>
                activeTags.some((tag) => tag.id === id),
              )}
              onChange={(values) => {
                mergeTags(activeTags, values);
              }}
            />
          ) : null}
          {inactiveTags.length > 0 ? (
            <Checkboxes
              legend={tTags('inactiveLegend')}
              options={inactiveTags.map((tag) => ({ value: tag.id, label: tag.name }))}
              selected={valuesOf(draft.tagId).filter((id) =>
                inactiveTags.some((tag) => tag.id === id),
              )}
              onChange={(values) => {
                mergeTags(inactiveTags, values);
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
              <Input
                type="number"
                inputMode="numeric"
                min={2000}
                max={2100}
                value={single('year')}
                onChange={(event) => {
                  set('year', event.target.value);
                }}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-1">
            {(['overdue', 'targetDateOverdue'] as const).map((key) => (
              <div key={key} className="flex min-h-9 items-center gap-2">
                <Checkbox
                  id={`${flagsId}-${key}`}
                  checked={draft[key] === 'true'}
                  onCheckedChange={(checked) => {
                    set(key, checked === true ? 'true' : undefined);
                  }}
                />
                <Label htmlFor={`${flagsId}-${key}`} className="font-normal">
                  {t(key)}
                </Label>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['createdFrom', 'createdTo', 'targetDateFrom', 'targetDateTo'] as const).map(
              (key) => (
                <Field key={key} label={t(key)}>
                  <DatePicker
                    clearable
                    value={fromIsoDate(draft[key])}
                    onValueChange={(date) => {
                      set(key, date ? toIsoDate(date) : undefined);
                    }}
                    labels={{
                      placeholder: t('datePlaceholder'),
                      clear: t('dateClear'),
                      calendar: t('dateCalendar', { label: t(key) }),
                    }}
                  />
                </Field>
              ),
            )}
            <Field label={t('estimatedValueMin')}>
              <Input
                inputMode="decimal"
                placeholder={t('valueHint')}
                value={minText}
                onChange={(event) => {
                  setMinText(event.target.value);
                }}
              />
            </Field>
            <Field label={t('estimatedValueMax')}>
              <Input
                inputMode="decimal"
                placeholder={t('valueHint')}
                value={maxText}
                onChange={(event) => {
                  setMaxText(event.target.value);
                }}
              />
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
