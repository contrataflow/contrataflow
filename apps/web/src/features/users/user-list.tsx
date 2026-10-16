'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { StatusBadge } from './status-badge';
import {
  EMPTY_USER_FILTERS,
  INVITATIONS_STALE_TIME_MS,
  LOOKUP_STALE_TIME_MS,
  USER_STATUS_FILTERS,
  fetchUsers,
  lookupDepartments,
  userKeys,
} from './users.api';
import type { UserListFilters } from './users.api';

const DEBOUNCE_MS = 300;
const CONTROL = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

/** Rota do detalhe (SCR-029). */
export const userDetailPath = (userId: string) => `/admin/usuarios/${userId}`;

/**
 * `UserList` (SCR-029 · US-092 · USR-01): vínculos do tenant com busca (≥ 2 caracteres, com
 * debounce), filtros por status, tipo e lotação e paginação; o nome leva ao detalhe. Abaixo de
 * 768 px cada linha vira um cartão (mesma tabela, cabeçalho só para leitores de tela).
 */
export function UserList() {
  const t = useTranslations('users');
  const tenantId = useTenantId();
  const ids = useId();
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selects, setSelects] = useState<Omit<UserListFilters, 'q'>>({
    status: EMPTY_USER_FILTERS.status,
    type: EMPTY_USER_FILTERS.type,
    departmentId: EMPTY_USER_FILTERS.departmentId,
  });
  const filters = useMemo<UserListFilters>(
    () => ({ ...selects, q: debouncedQ }),
    [selects, debouncedQ],
  );
  // Qualquer mudança de filtro volta à página 1 (a página guarda os filtros em que foi escolhida).
  const filterKey = JSON.stringify(filters);
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const goToPage = (next: number) => {
    setPageState({ key: filterKey, page: next });
  };

  // A busca só entra nos filtros depois do debounce e com ao menos 2 caracteres.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(search.trim().length >= 2 ? search.trim() : '');
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  const setFilter = <K extends keyof typeof selects>(key: K, value: (typeof selects)[K]) => {
    setSelects((current) => ({ ...current, [key]: value }));
  };

  const users = useQuery({
    queryKey: userKeys.list(tenantId, filters, page),
    queryFn: ({ signal }) => fetchUsers(filters, page, signal),
    staleTime: INVITATIONS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    // Erros (403, 5xx) são tratados na própria tela, com "Tentar novamente".
    throwOnError: false,
  });

  // DEP-02 (até 50 unidades ativas): opções do filtro e nomes da lotação principal.
  const departments = useQuery({
    queryKey: userKeys.departmentLookup(tenantId, ''),
    queryFn: async ({ signal }) => (await lookupDepartments('', signal)).data,
    staleTime: LOOKUP_STALE_TIME_MS,
    retry: false,
    throwOnError: false,
  });
  const departmentName = useMemo(
    () => new Map((departments.data ?? []).map((unit) => [unit.id, unit.name])),
    [departments.data],
  );

  if (users.error && isApiError(users.error) && users.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const items = users.data?.items ?? [];
  const totalPages = users.data?.totalPages ?? 1;
  const filtered =
    filters.q !== '' || filters.status !== '' || filters.type !== '' || filters.departmentId !== '';

  return (
    <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-4">
      <h2 id={`${ids}-title`} className="text-lg font-semibold">
        {t('directory.title')}
      </h2>

      <form
        role="search"
        aria-label={t('directory.title')}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-q`} className="text-sm font-medium">
            {t('directory.search')}
          </label>
          <input
            id={`${ids}-q`}
            type="search"
            autoComplete="off"
            className={CONTROL}
            value={search}
            aria-describedby={`${ids}-q-hint`}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <p id={`${ids}-q-hint`} className="text-xs text-muted-foreground">
            {t('directory.searchHint')}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-status`} className="text-sm font-medium">
            {t('directory.status')}
          </label>
          <select
            id={`${ids}-status`}
            className={CONTROL}
            value={filters.status}
            onChange={(event) => {
              setFilter('status', event.target.value);
            }}
          >
            <option value="">{t('directory.allStatuses')}</option>
            {USER_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-type`} className="text-sm font-medium">
            {t('directory.type')}
          </label>
          <select
            id={`${ids}-type`}
            className={CONTROL}
            value={filters.type}
            onChange={(event) => {
              const value = event.target.value;
              setFilter('type', value === 'INTERNAL' || value === 'EXTERNAL' ? value : '');
            }}
          >
            <option value="">{t('directory.allTypes')}</option>
            <option value="INTERNAL">{t('types.INTERNAL')}</option>
            <option value="EXTERNAL">{t('types.EXTERNAL')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-department`} className="text-sm font-medium">
            {t('directory.department')}
          </label>
          <select
            id={`${ids}-department`}
            className={CONTROL}
            value={filters.departmentId}
            onChange={(event) => {
              setFilter('departmentId', event.target.value);
            }}
          >
            <option value="">{t('directory.allDepartments')}</option>
            {(departments.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.path === unit.name ? unit.name : unit.path}
              </option>
            ))}
          </select>
        </div>
      </form>

      {users.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('directory.loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {users.isError ? (
        <Alert tone="error" title={t('directory.loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void users.refetch();
            }}
          >
            {t('directory.retry')}
          </Button>
        </Alert>
      ) : null}

      {users.data && items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t('directory.empty')}</p>
          {filtered ? (
            <p className="mt-1 text-sm text-muted-foreground">{t('directory.emptyHint')}</p>
          ) : null}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div
          aria-busy={users.isPlaceholderData}
          className="rounded-card border border-border bg-surface shadow-card md:overflow-x-auto"
        >
          <table className="w-full text-left text-sm md:min-w-[56rem]">
            <caption className="sr-only">{t('directory.caption')}</caption>
            <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
              <tr>
                <th scope="col" className="px-3 py-2">
                  {t('directory.name')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('directory.email')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('directory.jobTitle')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('directory.primaryDepartment')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('directory.typeColumn')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('directory.statusColumn')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((member) => (
                <tr
                  key={member.id}
                  className="border-t border-border align-top max-md:block max-md:py-2"
                >
                  <th scope="row" className="px-3 py-2 font-medium max-md:block">
                    <Link
                      href={userDetailPath(member.userId)}
                      className="underline-offset-2 hover:underline"
                    >
                      {member.name}
                    </Link>
                  </th>
                  <td className="px-3 py-2 break-all max-md:block max-md:py-1">{member.email}</td>
                  <td className="px-3 py-2 max-md:block max-md:py-1">
                    {member.jobTitle ?? t('detail.none')}
                  </td>
                  <td className="px-3 py-2 max-md:block max-md:py-1">
                    {(member.primaryDepartmentId
                      ? departmentName.get(member.primaryDepartmentId)
                      : null) ?? t('detail.none')}
                  </td>
                  <td className="px-3 py-2 max-md:block max-md:py-1">
                    {t(`types.${member.type}`)}
                  </td>
                  <td className="px-3 py-2 max-md:block max-md:py-1">
                    <StatusBadge membership={member} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {totalPages > 1 ? (
        <nav aria-label={t('directory.pager')} className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              goToPage(Math.max(1, page - 1));
            }}
          >
            {t('list.previous')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('list.pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              goToPage(page + 1);
            }}
          >
            {t('list.next')}
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
