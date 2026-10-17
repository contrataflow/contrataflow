'use client';

import {
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_RESULTS,
} from '@contrataflow/types';
import type { AuditAction, AuditCategory } from '@contrataflow/types';
import { Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { RefObject, SyntheticEvent } from 'react';

import { advancedFilterCount } from './audit-log-model';
import type { AuditFilterField, AuditFilterInput } from './audit-log-model';

const CONTROL = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

/** Ações do catálogo agrupadas pela categoria fixa (events.md §7), para o `<optgroup>`. */
const ACTIONS_BY_CATEGORY: readonly (readonly [AuditCategory, readonly AuditAction[]])[] =
  AUDIT_CATEGORIES.map((category) => [
    category,
    AUDIT_ACTION_NAMES.filter((action) => AUDIT_ACTIONS[action].category === category),
  ]);

export interface AuditFiltersPanelProps {
  readonly value: AuditFilterInput;
  readonly onChange: (next: AuditFilterInput) => void;
  readonly onSearch: () => void;
  readonly onClear: () => void;
  readonly timeZone: string;
  /** Erros por campo (validação local ou 422 da API). */
  readonly errors: Partial<Record<AuditFilterField, string>>;
  /** Atores já vistos nos registros carregados. */
  readonly actors: readonly { readonly id: string; readonly name: string }[];
  readonly pending: boolean;
  /** Recebe o foco quando o período é recusado (V-01). */
  readonly periodRef: RefObject<HTMLInputElement | null>;
}

/**
 * `AuditFiltersPanel` (SCR-037 · US-075): `DateRangePicker` (período obrigatório, até 90 dias, no
 * fuso da instituição), ação (seleção múltipla agrupada por categoria), categoria e resultado; ator,
 * entidade e processo num `CollapsibleSection` ("Filtros avançados"). Controles nativos em
 * `fieldset`/`legend`, navegáveis por teclado; "Pesquisar" submete o formulário.
 */
export function AuditFiltersPanel({
  value,
  onChange,
  onSearch,
  onClear,
  timeZone,
  errors,
  actors,
  pending,
  periodRef,
}: AuditFiltersPanelProps) {
  const t = useTranslations('audit.records.filters');
  const tActions = useTranslations('audit.actions');
  const tCategories = useTranslations('audit.categories');
  const tResults = useTranslations('audit.results');
  const id = useId();
  const advanced = advancedFilterCount(value);
  const set = (patch: Partial<AuditFilterInput>) => {
    onChange({ ...value, ...patch });
  };
  const errorId = (field: AuditFilterField) => `${id}-${field}-error`;
  const fieldError = (field: AuditFilterField) =>
    errors[field] === undefined ? null : (
      <p id={errorId(field)} className="text-sm text-destructive">
        {errors[field]}
      </p>
    );
  const described = (field: AuditFilterField, hint?: string) =>
    [errors[field] === undefined ? null : errorId(field), hint ?? null]
      .filter((item) => item !== null)
      .join(' ') || undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch();
  };

  return (
    <form
      aria-label={t('label')}
      noValidate
      onSubmit={submit}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-start">
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('period')}</legend>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-from`} className="text-sm">
                {t('from')}
              </label>
              <input
                ref={periodRef}
                id={`${id}-from`}
                type="datetime-local"
                className={CONTROL}
                value={value.from}
                required
                aria-invalid={errors.from === undefined ? undefined : true}
                aria-describedby={described('from', `${id}-period-hint`)}
                onChange={(event) => {
                  set({ from: event.target.value });
                }}
              />
              {fieldError('from')}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-to`} className="text-sm">
                {t('to')}
              </label>
              <input
                id={`${id}-to`}
                type="datetime-local"
                className={CONTROL}
                value={value.to}
                required
                aria-invalid={errors.to === undefined ? undefined : true}
                aria-describedby={described('to', `${id}-period-hint`)}
                onChange={(event) => {
                  set({ to: event.target.value });
                }}
              />
              {fieldError('to')}
            </div>
          </div>
          <p id={`${id}-period-hint`} className="max-w-xs text-xs text-muted-foreground">
            {t('periodHint', { timeZone })}
          </p>
        </fieldset>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-action`} className="text-sm font-medium">
            {t('action')}
          </label>
          <select
            id={`${id}-action`}
            multiple
            size={5}
            className="min-w-56 rounded-control border border-border bg-surface px-2 py-1 text-sm"
            value={[...value.actions]}
            aria-describedby={`${id}-action-hint`}
            onChange={(event) => {
              set({ actions: [...event.target.selectedOptions].map((option) => option.value) });
            }}
          >
            {ACTIONS_BY_CATEGORY.map(([category, actions]) => (
              <optgroup key={category} label={tCategories(category)}>
                {actions.map((action) => (
                  <option key={action} value={action}>
                    {tActions(action)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p id={`${id}-action-hint`} className="max-w-56 text-xs text-muted-foreground">
            {t('actionHint')}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-category`} className="text-sm font-medium">
              {t('category')}
            </label>
            <select
              id={`${id}-category`}
              className={CONTROL}
              value={value.category}
              onChange={(event) => {
                set({ category: event.target.value });
              }}
            >
              <option value="">{t('any')}</option>
              {AUDIT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {tCategories(category)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-result`} className="text-sm font-medium">
              {t('result')}
            </label>
            <select
              id={`${id}-result`}
              className={CONTROL}
              value={value.result}
              onChange={(event) => {
                set({ result: event.target.value });
              }}
            >
              <option value="">{t('anyResult')}</option>
              {AUDIT_RESULTS.map((result) => (
                <option key={result} value={result}>
                  {tResults(result)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <details
        className="group rounded-control border border-border"
        open={advanced > 0 || undefined}
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          {advanced > 0 ? t('advancedActive', { count: advanced }) : t('advanced')}
        </summary>
        <div className="flex flex-wrap gap-3 border-t border-border p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-actor`} className="text-sm">
              {t('actor')}
            </label>
            <select
              id={`${id}-actor`}
              className={CONTROL}
              value={value.actorUserId}
              aria-describedby={described('actorUserId', `${id}-actor-hint`)}
              onChange={(event) => {
                set({ actorUserId: event.target.value });
              }}
            >
              <option value="">{t('anyActor')}</option>
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </select>
            <p id={`${id}-actor-hint`} className="text-xs text-muted-foreground">
              {t('actorHint')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-entity-type`} className="text-sm">
              {t('entityType')}
            </label>
            <input
              id={`${id}-entity-type`}
              className={CONTROL}
              value={value.entityType}
              maxLength={60}
              aria-describedby={`${id}-entity-type-hint`}
              onChange={(event) => {
                set({ entityType: event.target.value });
              }}
            />
            <p id={`${id}-entity-type-hint`} className="text-xs text-muted-foreground">
              {t('entityTypeHint')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-entity-id`} className="text-sm">
              {t('entityId')}
            </label>
            <input
              id={`${id}-entity-id`}
              className={`${CONTROL} w-80 max-w-full font-mono`}
              value={value.entityId}
              aria-invalid={errors.entityId === undefined ? undefined : true}
              aria-describedby={described('entityId')}
              onChange={(event) => {
                set({ entityId: event.target.value });
              }}
            />
            {fieldError('entityId')}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-process-id`} className="text-sm">
              {t('processId')}
            </label>
            <input
              id={`${id}-process-id`}
              className={`${CONTROL} w-80 max-w-full font-mono`}
              value={value.processId}
              aria-invalid={errors.processId === undefined ? undefined : true}
              aria-describedby={described('processId')}
              onChange={(event) => {
                set({ processId: event.target.value });
              }}
            />
            {fieldError('processId')}
          </div>
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {t('search')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClear}>
          {t('clear')}
        </Button>
      </div>
    </form>
  );
}
