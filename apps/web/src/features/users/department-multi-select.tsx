'use client';

import { Button } from '@contrataflow/ui';
import type { DepartmentLookupItem } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { LOOKUP_STALE_TIME_MS, lookupDepartments, userKeys } from './users.api';

const DEBOUNCE_MS = 250;

export interface DepartmentMultiSelectProps {
  /** Id do campo de busca (alvo do foco em caso de erro). */
  readonly id: string;
  /** Ids selecionados; o primeiro é a lotação principal. */
  readonly value: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly error?: string | undefined;
}

/**
 * Seleção múltipla de unidades (DEP-02 · só ativas) do convite: busca simples + lista de caixas de
 * seleção; as escolhidas aparecem como itens removíveis e a primeira é a lotação principal. Não
 * mostra a árvore: o `path` da unidade basta para distinguir homônimas.
 */
export function DepartmentMultiSelect({ id, value, onChange, error }: DepartmentMultiSelectProps) {
  const t = useTranslations('users.form');
  const tenantId = useTenantId();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  /** Nomes das unidades já escolhidas, para sobreviver a uma nova busca. */
  const [known, setKnown] = useState<ReadonlyMap<string, DepartmentLookupItem>>(new Map());

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim().length >= 2 ? search.trim() : '');
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  const lookup = useQuery({
    queryKey: userKeys.departmentLookup(tenantId, debounced),
    queryFn: async ({ signal }) => (await lookupDepartments(debounced, signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
  });

  const toggle = (item: DepartmentLookupItem, checked: boolean) => {
    setKnown((current) => new Map(current).set(item.id, item));
    onChange(checked ? [...value, item.id] : value.filter((selected) => selected !== item.id));
  };

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const optionsLabelId = `${id}-options`;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{t('departments')}</legend>
      <p id={hintId} className="text-sm text-muted-foreground">
        {t('departmentsHint')}
      </p>

      {value.length > 0 ? (
        <ul aria-label={t('departmentsSelected')} className="flex flex-wrap gap-2">
          {value.map((departmentId, index) => {
            const name = known.get(departmentId)?.name ?? departmentId;
            return (
              <li
                key={departmentId}
                className="inline-flex items-center gap-1 rounded-control bg-muted px-2 py-1 text-sm"
              >
                <span>{name}</span>
                {index === 0 ? (
                  <span className="text-xs text-muted-foreground">({t('primary')})</span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('removeDepartment', { name })}
                  onClick={() => {
                    onChange(value.filter((selected) => selected !== departmentId));
                  }}
                >
                  ×
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {t('departmentSearch')}
        </label>
        <input
          id={id}
          type="search"
          autoComplete="off"
          className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
          value={search}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, error ? errorId : undefined].filter(Boolean).join(' ')}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter na busca não envia o convite.
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
        <p className="text-xs text-muted-foreground">{t('departmentSearchHint')}</p>
      </div>

      <div
        role="group"
        aria-labelledby={optionsLabelId}
        aria-busy={lookup.isFetching}
        className="max-h-48 overflow-y-auto rounded-control border border-border"
      >
        <p id={optionsLabelId} className="sr-only">
          {t('departmentOptions')}
        </p>
        {lookup.isPending ? (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            {t('departmentsLoading')}
          </p>
        ) : null}
        {lookup.isError ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {t('departmentsFailed')}
          </p>
        ) : null}
        {lookup.data?.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t('departmentsEmpty')}</p>
        ) : null}
        {lookup.data && lookup.data.length > 0 ? (
          <ul className="divide-y divide-border">
            {lookup.data.map((item) => {
              const optionId = `${id}-option-${item.id}`;
              return (
                <li key={item.id} className="flex items-start gap-2 px-3 py-2">
                  <input
                    id={optionId}
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={value.includes(item.id)}
                    onChange={(event) => {
                      toggle(item, event.target.checked);
                    }}
                  />
                  <label htmlFor={optionId} className="text-sm">
                    <span className="font-medium">{item.name}</span>
                    {item.path === item.name ? null : (
                      <span className="block text-xs text-muted-foreground">{item.path}</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
