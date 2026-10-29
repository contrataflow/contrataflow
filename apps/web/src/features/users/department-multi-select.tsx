'use client';

import {
  Button,
  Check,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Field,
  Label,
  Plus,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  X,
} from '@contrataflow/ui';
import type { DepartmentLookupItem } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { LOOKUP_STALE_TIME_MS, lookupDepartments, userKeys } from './users.api';

const DEBOUNCE_MS = 250;

export interface DepartmentMultiSelectProps {
  /** Id do botão "Adicionar unidade" (alvo do foco em caso de erro). */
  readonly id: string;
  /** Ids selecionados; o primeiro é a lotação principal. */
  readonly value: readonly string[];
  readonly onChange: (ids: string[]) => void;
  readonly error?: string | undefined;
  /** Nomes de unidades já conhecidas (ex.: as lotações atuais do vínculo), por id. */
  readonly names?: ReadonlyMap<string, string> | undefined;
  /**
   * Com `onPrimaryChange`, a lotação principal é escolhida de forma explícita (botão de opção em
   * cada unidade selecionada); sem ele, a primeira selecionada é a principal (convite).
   */
  readonly primary?: string | null | undefined;
  readonly onPrimaryChange?: ((departmentId: string) => void) | undefined;
  /** Substitui a dica padrão ("A primeira selecionada é a lotação principal."). */
  readonly hint?: string | undefined;
}

/**
 * Seleção múltipla de unidades (DEP-02 · só ativas): as escolhidas aparecem como itens removíveis
 * (a primeira é a lotação principal, ou a escolhida num grupo de opções) e "Adicionar unidade" abre
 * uma lista suspensa com busca no servidor (≥ 2 letras), onde cada unidade marca/desmarca. Não
 * mostra a árvore: o `path` da unidade basta para distinguir homônimas.
 */
export function DepartmentMultiSelect({
  id,
  value,
  onChange,
  error,
  names,
  primary,
  onPrimaryChange,
  hint,
}: DepartmentMultiSelectProps) {
  const t = useTranslations('users.form');
  const tenantId = useTenantId();
  const [open, setOpen] = useState(false);
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
    enabled: open,
  });

  const toggle = (item: DepartmentLookupItem) => {
    setKnown((current) => new Map(current).set(item.id, item));
    onChange(
      value.includes(item.id)
        ? value.filter((selected) => selected !== item.id)
        : [...value, item.id],
    );
  };

  const nameOf = (departmentId: string) =>
    known.get(departmentId)?.name ?? names?.get(departmentId) ?? departmentId;

  const remove = (departmentId: string) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={t('removeDepartment', { name: nameOf(departmentId) })}
      onClick={() => {
        onChange(value.filter((selected) => selected !== departmentId));
      }}
    >
      <X aria-hidden="true" />
    </Button>
  );

  const itemClass =
    'inline-flex items-center gap-1 rounded-control bg-muted py-1 pr-1 pl-2.5 text-sm';

  return (
    <Field group label={t('departments')} description={hint ?? t('departmentsHint')} error={error}>
      {value.length > 0 && onPrimaryChange ? (
        <RadioGroup
          value={primary ?? ''}
          aria-label={t('primaryGroup')}
          onValueChange={onPrimaryChange}
        >
          <ul aria-label={t('departmentsSelected')} className="flex flex-wrap gap-2">
            {value.map((departmentId) => {
              const name = nameOf(departmentId);
              const radioId = `${id}-primary-${departmentId}`;
              return (
                <li key={departmentId} className={itemClass}>
                  <span>{name}</span>
                  <RadioGroupItem
                    id={radioId}
                    value={departmentId}
                    aria-label={t('setPrimary', { name })}
                    className="ml-1.5"
                  />
                  <Label
                    htmlFor={radioId}
                    aria-hidden="true"
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {t('primaryChoice')}
                  </Label>
                  {remove(departmentId)}
                </li>
              );
            })}
          </ul>
        </RadioGroup>
      ) : null}

      {value.length > 0 && !onPrimaryChange ? (
        <ul aria-label={t('departmentsSelected')} className="flex flex-wrap gap-2">
          {value.map((departmentId, index) => (
            <li key={departmentId} className={itemClass}>
              <span>{nameOf(departmentId)}</span>
              {index === 0 ? (
                <span className="text-xs text-muted-foreground">({t('primary')})</span>
              ) : null}
              {remove(departmentId)}
            </li>
          ))}
        </ul>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="secondary"
            iconLeft={<Plus />}
            className="self-start"
            aria-invalid={error ? true : undefined}
          >
            {t('departmentAdd')}
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label={t('departmentOptions')} className="w-96 p-0">
          {/* A busca é no servidor (DEP-02): o filtro local do cmdk fica desligado. */}
          <Command shouldFilter={false} label={t('departmentOptions')}>
            <CommandInput
              placeholder={t('departmentSearch')}
              aria-label={t('departmentSearch')}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList aria-busy={lookup.isFetching} label={t('departmentOptions')}>
              {lookup.isPending ? (
                <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('departmentsLoading')}
                </p>
              ) : null}
              {lookup.isError ? (
                <p role="alert" className="px-3 py-6 text-center text-sm text-destructive">
                  {t('departmentsFailed')}
                </p>
              ) : null}
              {lookup.data?.length === 0 ? (
                <CommandEmpty>{t('departmentsEmpty')}</CommandEmpty>
              ) : null}
              <CommandGroup>
                {(lookup.data ?? []).map((item) => {
                  const selected = value.includes(item.id);
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => {
                        toggle(item);
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.name}</span>
                        {item.path === item.name ? null : (
                          <span className="truncate text-xs text-muted-foreground">
                            {item.path}
                          </span>
                        )}
                      </span>
                      {selected ? (
                        <>
                          <Check className="text-primary" />
                          <span className="sr-only">{t('departmentSelected')}</span>
                        </>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {t('departmentSearchHint')}
          </p>
        </PopoverContent>
      </Popover>
    </Field>
  );
}
