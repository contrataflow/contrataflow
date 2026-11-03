'use client';

import {
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_RESULTS,
} from '@contrataflow/types';
import type { AuditAction, AuditCategory } from '@contrataflow/types';
import {
  Button,
  Combobox,
  DateRangePicker,
  Field,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import type { DateRange } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import type { SyntheticEvent } from 'react';

import type { AuditFilterField, AuditFilterInput } from './audit-log-model';

/** Ações do catálogo agrupadas pela categoria fixa (events.md §7). */
const ACTIONS_BY_CATEGORY: readonly (readonly [AuditCategory, readonly AuditAction[]])[] =
  AUDIT_CATEGORIES.map((category) => [
    category,
    AUDIT_ACTION_NAMES.filter((action) => AUDIT_ACTIONS[action].category === category),
  ]);

/** O `Select` do kit não aceita valor vazio: "Todas/Todos" usa este marcador. */
const ANY = 'any';

/** `id` do seletor de período: recebe o foco quando o período é recusado (V-01/V-02). */
export const AUDIT_PERIOD_FIELD_ID = 'auditoria-periodo';

/** Período do painel (`YYYY-MM-DDTHH:mm` no fuso da instituição) como dias do calendário. */
export function periodRange(value: AuditFilterInput): DateRange | undefined {
  const from = fromIsoDate(value.from.slice(0, 10));
  if (from === undefined) return undefined;
  return { from, to: fromIsoDate(value.to.slice(0, 10)) };
}

/** Dias escolhidos no calendário → período do primeiro minuto do início ao último do fim. */
export function periodOfRange(range: DateRange | undefined): Pick<AuditFilterInput, 'from' | 'to'> {
  if (range?.from === undefined) return { from: '', to: '' };
  const to = range.to ?? range.from;
  return { from: `${toIsoDate(range.from)}T00:00`, to: `${toIsoDate(to)}T23:59` };
}

export interface AuditPrimaryFiltersProps {
  readonly value: AuditFilterInput;
  /** Aplica na hora (prd-6 §2.4): o período só quando os dois dias foram escolhidos. */
  readonly onApply: (next: AuditFilterInput) => void;
  /** Atualiza o rascunho sem pesquisar (período com só o primeiro dia escolhido). */
  readonly onDraft: (next: AuditFilterInput) => void;
  readonly timeZone: string;
  readonly errors: Partial<Record<AuditFilterField, string>>;
}

/**
 * Filtros principais da aba "Registros" no cartão aberto da lista (prd-6 §2.4): período no
 * `DateRangePicker` (obrigatório, até 90 dias, no fuso da instituição), ação (agrupada por
 * categoria), categoria e resultado. Cada mudança pesquisa na hora; ator, entidade e processo
 * ficam em "Mais filtros" (`AuditFiltersPanel`).
 */
export function AuditPrimaryFilters({
  value,
  onApply,
  onDraft,
  timeZone,
  errors,
}: AuditPrimaryFiltersProps) {
  const t = useTranslations('audit.records.filters');
  const tActions = useTranslations('audit.actions');
  const tCategories = useTranslations('audit.categories');
  const tResults = useTranslations('audit.results');
  const apply = (patch: Partial<AuditFilterInput>) => {
    onApply({ ...value, ...patch });
  };

  return (
    <>
      <Field
        id={AUDIT_PERIOD_FIELD_ID}
        label={t('period')}
        description={t('periodHint', { timeZone })}
        error={errors.from ?? errors.to}
        className="sm:col-span-2"
      >
        <DateRangePicker
          value={periodRange(value)}
          onValueChange={(range) => {
            if (range?.from !== undefined && range.to === undefined) {
              onDraft({ ...value, from: `${toIsoDate(range.from)}T00:00`, to: '' });
              return;
            }
            apply(periodOfRange(range));
          }}
          labels={{
            placeholder: t('periodPlaceholder'),
            calendar: t('periodCalendar'),
            clear: t('periodClear'),
          }}
        />
      </Field>

      <Field label={t('action')}>
        <Select
          value={value.actions[0] ?? ANY}
          onValueChange={(action) => {
            apply({ actions: action === ANY ? [] : [action] });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('any')}</SelectItem>
            {ACTIONS_BY_CATEGORY.map(([category, actions]) => (
              <SelectGroup key={category}>
                <SelectLabel>{tCategories(category)}</SelectLabel>
                {actions.map((action) => (
                  <SelectItem key={action} value={action}>
                    {tActions(action)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={t('category')}>
        <Select
          value={value.category === '' ? ANY : value.category}
          onValueChange={(category) => {
            apply({ category: category === ANY ? '' : category });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('any')}</SelectItem>
            {AUDIT_CATEGORIES.map((category) => (
              <SelectItem key={category} value={category}>
                {tCategories(category)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={t('result')}>
        <Select
          value={value.result === '' ? ANY : value.result}
          onValueChange={(result) => {
            apply({ result: result === ANY ? '' : result });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('anyResult')}</SelectItem>
            {AUDIT_RESULTS.map((result) => (
              <SelectItem key={result} value={result}>
                {tResults(result)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

export interface AuditFiltersPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly value: AuditFilterInput;
  readonly onChange: (next: AuditFilterInput) => void;
  readonly onSearch: () => void;
  readonly onClear: () => void;
  /** Erros por campo (validação local ou 422 da API). */
  readonly errors: Partial<Record<AuditFilterField, string>>;
  /** Atores já vistos nos registros carregados. */
  readonly actors: readonly { readonly id: string; readonly name: string }[];
  readonly pending: boolean;
}

/**
 * `AuditFiltersPanel` (SCR-037 · US-075): "Mais filtros" da aba "Registros" (prd-6 §2.4) — painel
 * lateral com o que não está no cartão aberto: ator no `Combobox`, entidade e processo.
 * "Pesquisar" submete o formulário; os erros ficam no campo.
 */
export function AuditFiltersPanel({
  open,
  onOpenChange,
  value,
  onChange,
  onSearch,
  onClear,
  errors,
  actors,
  pending,
}: AuditFiltersPanelProps) {
  const t = useTranslations('audit.records.filters');
  const set = (patch: Partial<AuditFilterInput>) => {
    onChange({ ...value, ...patch });
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t('close')}>
        <form
          aria-label={t('title')}
          noValidate
          onSubmit={submit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>{t('description')}</SheetDescription>
          </SheetHeader>
          <SheetBody>
            <Field label={t('actor')} description={t('actorHint')} error={errors.actorUserId}>
              <Combobox
                clearable
                options={actors.map((actor) => ({ value: actor.id, label: actor.name }))}
                value={value.actorUserId === '' ? undefined : value.actorUserId}
                onValueChange={(actorUserId) => {
                  set({ actorUserId: actorUserId ?? '' });
                }}
                labels={{
                  placeholder: t('anyActor'),
                  search: t('actorSearch'),
                  empty: t('actorEmpty'),
                }}
              />
            </Field>

            <fieldset className="m-0 flex flex-col gap-4 border-0 p-0">
              <legend className="mb-3 text-sm font-bold text-brand-ink">{t('advanced')}</legend>
              <Field label={t('entityType')} description={t('entityTypeHint')}>
                <Input
                  value={value.entityType}
                  maxLength={60}
                  onChange={(event) => {
                    set({ entityType: event.target.value });
                  }}
                />
              </Field>
              <Field label={t('entityId')} error={errors.entityId}>
                <Input
                  className="font-mono"
                  value={value.entityId}
                  onChange={(event) => {
                    set({ entityId: event.target.value });
                  }}
                />
              </Field>
              <Field label={t('processId')} error={errors.processId}>
                <Input
                  className="font-mono"
                  value={value.processId}
                  onChange={(event) => {
                    set({ processId: event.target.value });
                  }}
                />
              </Field>
            </fieldset>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="ghost" onClick={onClear}>
              {t('clear')}
            </Button>
            <Button type="submit" disabled={pending}>
              {t('search')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
