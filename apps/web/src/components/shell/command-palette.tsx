'use client';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@contrataflow/ui';
import { PROCESS_LIST_QUERY_LIMITS } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { searchValue } from '@/features/process-list/process-list-state';
import { fetchProcessList, processListKeys } from '@/features/process-list/process-list.api';
import { NEW_PROCESS_PATH } from '@/features/processes/new-process-button';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { Icon } from './icons';
import { MAIN_NAV } from './navigation';
import type { NavItem } from './navigation';

/** Quantos processos a paleta mostra; o resto fica em "Ver todos". */
const PALETTE_RESULTS = '5';
const DEBOUNCE_MS = 250;

/** Comparação sem acento nem caixa ("aprovacoes" acha "Aprovações"). */
const normalize = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);
  return debounced;
}

/** Item que exige permissão: some quando a API confirma que falta (RN-FND-92), como no menu. */
function Gated({
  permission,
  children,
}: {
  readonly permission: string | undefined;
  readonly children: ReactNode;
}) {
  const { allowed, status } = usePermission(permission ?? '');
  if (permission !== undefined && status === 'success' && !allowed) return null;
  return children;
}

/**
 * Processos que casam a busca (PRC-01 com `q`, a mesma consulta da lista de processos). Os avisos
 * (busca curta, buscando, falha) são `div` sem papel: dentro do `listbox` só cabem opções e grupos.
 */
function ProcessResults({
  query,
  onGo,
}: {
  readonly query: string;
  readonly onGo: (href: string) => void;
}) {
  const t = useTranslations('shell.palette');
  const tenantId = useTenantId();
  const debounced = useDebounced(query);
  const { value, tooShort } = searchValue(debounced);
  const params = { q: value ?? '', pageSize: PALETTE_RESULTS };
  const results = useQuery({
    queryKey: processListKeys.list(tenantId, params),
    queryFn: ({ signal }) => fetchProcessList(params, signal),
    enabled: value !== undefined,
    staleTime: 30_000,
    throwOnError: false,
  });
  if (query.trim() === '') return null;
  return (
    <CommandGroup heading={t('processes')}>
      {tooShort ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">
          {t('tooShort', { min: PROCESS_LIST_QUERY_LIMITS.qMin })}
        </div>
      ) : null}
      {results.isFetching && results.data === undefined ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">{t('searching')}</div>
      ) : null}
      {results.isError ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">{t('searchFailed')}</div>
      ) : null}
      {value !== undefined
        ? (results.data?.items ?? []).map((item) => (
            <CommandItem
              key={item.id}
              value={`processo-${item.id}`}
              onSelect={() => {
                onGo(`/processos/${item.id}`);
              }}
            >
              <Icon name="folder" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold text-brand-ink">{item.title}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {item.code ?? t('draft')}
                </span>
              </span>
            </CommandItem>
          ))
        : null}
      {value !== undefined ? (
        <CommandItem
          value="processos-ver-todos"
          onSelect={() => {
            onGo(`/processos?q=${encodeURIComponent(value)}`);
          }}
        >
          <Icon name="search" />
          {t('seeAll', { query: value })}
        </CommandItem>
      ) : null}
    </CommandGroup>
  );
}

/**
 * Paleta de comandos do shell (prd-5 · §4 card 2): Ctrl K abre de qualquer ponto. "Ir para" as
 * áreas do menu (com as mesmas permissões), "Novo processo" e a busca de processos por número,
 * título ou objeto. O filtro das rotas é local (sem acento); o de processos, o da API.
 */
export function CommandPalette({
  open,
  onOpenChange,
  showExample,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly showExample: boolean;
}) {
  const t = useTranslations('shell');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const term = normalize(query.trim());
  const matches = (label: string) => term === '' || normalize(label).includes(term);

  const go = (href: string) => {
    onOpenChange(false);
    setQuery('');
    router.push(href);
  };
  const routes = MAIN_NAV.filter(
    (item: NavItem) =>
      (showExample || item.labelKey !== 'example') && matches(t(`nav.${item.labelKey}`)),
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
      title={t('palette.title')}
      label={t('palette.label')}
      shouldFilter={false}
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder={t('palette.placeholder')} />
      <CommandList label={t('palette.label')}>
        <CommandEmpty>{t('palette.empty')}</CommandEmpty>
        <ProcessResults query={query} onGo={go} />
        {matches(t('palette.newProcess')) ? (
          <Gated permission="PROCESS_CREATE">
            <CommandGroup heading={t('palette.actions')}>
              <CommandItem
                value="acao-novo-processo"
                onSelect={() => {
                  go(NEW_PROCESS_PATH);
                }}
              >
                <Icon name="plus" />
                {t('palette.newProcess')}
              </CommandItem>
            </CommandGroup>
          </Gated>
        ) : null}
        {routes.length > 0 ? (
          <CommandGroup heading={t('palette.goTo')}>
            {routes.map((item) => (
              <Gated key={item.href} permission={item.permission}>
                <CommandItem
                  value={`rota-${item.href}`}
                  onSelect={() => {
                    go(item.href);
                  }}
                >
                  <Icon name={item.icon} />
                  {t(`nav.${item.labelKey}`)}
                </CommandItem>
              </Gated>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
