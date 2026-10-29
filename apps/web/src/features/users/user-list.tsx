'use client';

import {
  Alert,
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Field,
  FilterToolbar,
  ListPage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
  Users,
} from '@contrataflow/ui';
import type { TenantMembershipDto } from '@contrataflow/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

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
/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';

/** Rota do detalhe (SCR-029). */
export const userDetailPath = (userId: string) => `/admin/usuarios/${userId}`;

export interface UserListProps {
  /** Cabeçalho da página (`AppPageHeader` com a ação "Convidar"); a lista é o corpo do `ListPage`. */
  readonly header?: ReactNode;
  /** Seções extras abaixo da tabela (convites pendentes). */
  readonly children?: ReactNode;
}

/**
 * `UserList` (SCR-029 · US-092 · USR-01) no modelo `ListPage` (prd-5): busca inline (≥ 2
 * caracteres, com debounce), situação, vínculo e lotação no popover "Filtros" com chips,
 * paginação no rodapé da tabela e menu ⋯ por linha ("Ver detalhes"). O nome leva ao detalhe.
 * A API não devolve perfis nem último acesso na lista: essas colunas ficam de fora.
 */
export function UserList({ header, children }: UserListProps) {
  const t = useTranslations('users');
  const tenantId = useTenantId();
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
      <ListPage
        header={header}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const items = users.data?.items ?? [];
  const totalPages = users.data?.totalPages ?? 1;
  const filtered =
    filters.q !== '' || filters.status !== '' || filters.type !== '' || filters.departmentId !== '';

  const typeLabel = (value: 'INTERNAL' | 'EXTERNAL') => t(`types.${value}`);
  const statusLabel = (value: string) =>
    (USER_STATUS_FILTERS as readonly string[]).includes(value)
      ? t(`statuses.${value as (typeof USER_STATUS_FILTERS)[number]}`)
      : value;
  const departmentLabel = (id: string) => departmentName.get(id) ?? id;
  const chips = [
    filters.status === ''
      ? null
      : {
          id: 'status',
          label: t('directory.chip', {
            field: t('directory.status'),
            value: statusLabel(filters.status),
          }),
          removeLabel: t('directory.removeChip', {
            field: t('directory.status'),
            value: statusLabel(filters.status),
          }),
          onRemove: () => {
            setFilter('status', '');
          },
        },
    filters.type === ''
      ? null
      : {
          id: 'type',
          label: t('directory.chip', {
            field: t('directory.type'),
            value: typeLabel(filters.type),
          }),
          removeLabel: t('directory.removeChip', {
            field: t('directory.type'),
            value: typeLabel(filters.type),
          }),
          onRemove: () => {
            setFilter('type', '');
          },
        },
    filters.departmentId === ''
      ? null
      : {
          id: 'department',
          label: t('directory.chip', {
            field: t('directory.department'),
            value: departmentLabel(filters.departmentId),
          }),
          removeLabel: t('directory.removeChip', {
            field: t('directory.department'),
            value: departmentLabel(filters.departmentId),
          }),
          onRemove: () => {
            setFilter('departmentId', '');
          },
        },
  ].filter((chip) => chip !== null);

  const clearAll = () => {
    setSelects({ status: '', type: '', departmentId: '' });
  };

  return (
    <ListPage
      header={header}
      toolbar={
        <FilterToolbar
          search={{
            value: search,
            onChange: setSearch,
            label: t('directory.search'),
            placeholder: t('directory.searchPlaceholder'),
            description: t('directory.searchHint'),
          }}
          activeCount={chips.length}
          onClearAll={clearAll}
          chips={chips}
          filters={
            <div className="flex flex-col gap-4">
              <Field label={t('directory.status')}>
                <Select
                  value={filters.status === '' ? ALL : filters.status}
                  onValueChange={(value) => {
                    setFilter('status', value === ALL ? '' : value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('directory.allStatuses')}</SelectItem>
                    {USER_STATUS_FILTERS.map((status) => (
                      <SelectItem key={status} value={status}>
                        {t(`statuses.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('directory.type')}>
                <Select
                  value={filters.type === '' ? ALL : filters.type}
                  onValueChange={(value) => {
                    setFilter('type', value === 'INTERNAL' || value === 'EXTERNAL' ? value : '');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('directory.allTypes')}</SelectItem>
                    <SelectItem value="INTERNAL">{t('types.INTERNAL')}</SelectItem>
                    <SelectItem value="EXTERNAL">{t('types.EXTERNAL')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('directory.department')}>
                <Select
                  value={filters.departmentId === '' ? ALL : filters.departmentId}
                  onValueChange={(value) => {
                    setFilter('departmentId', value === ALL ? '' : value);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('directory.allDepartments')}</SelectItem>
                    {(departments.data ?? []).map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.path === unit.name ? unit.name : unit.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          }
        />
      }
      loading={users.isPending}
      loadingLabel={t('directory.loading')}
      error={
        users.isError ? (
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
        ) : null
      }
      empty={
        users.data && items.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t('directory.empty')}
            description={filtered ? t('directory.emptyHint') : t('directory.emptyFirst')}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setDebouncedQ('');
                    clearAll();
                  }}
                >
                  {t('directory.clear')}
                </Button>
              ) : undefined
            }
          />
        ) : null
      }
    >
      {items.length > 0 && users.data ? (
        <TableContainer
          label={t('directory.caption')}
          aria-busy={users.isPlaceholderData}
          footer={
            <TableFooter summary={t('directory.total', { count: users.data.totalItems })}>
              {totalPages > 1 ? (
                <nav aria-label={t('directory.pager')} className="flex items-center gap-2">
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
                  <span>{t('list.pageOf', { page, total: totalPages })}</span>
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
            </TableFooter>
          }
        >
          <Table>
            <caption className="sr-only">{t('directory.caption')}</caption>
            <TableHead>
              <Tr>
                <Th>{t('directory.user')}</Th>
                <Th className="hidden md:table-cell">{t('directory.jobTitle')}</Th>
                <Th className="hidden lg:table-cell">{t('directory.primaryDepartment')}</Th>
                <Th className="hidden md:table-cell">{t('directory.typeColumn')}</Th>
                <Th>{t('directory.statusColumn')}</Th>
                <Th className="w-12">
                  <span className="sr-only">{t('directory.actions')}</span>
                </Th>
              </Tr>
            </TableHead>
            <TableBody>
              {items.map((member) => (
                <UserRow
                  key={member.id}
                  member={member}
                  departmentName={
                    (member.primaryDepartmentId
                      ? departmentName.get(member.primaryDepartmentId)
                      : null) ?? t('detail.none')
                  }
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
      {children}
    </ListPage>
  );
}

function UserRow({
  member,
  departmentName,
}: {
  readonly member: TenantMembershipDto;
  readonly departmentName: string;
}) {
  const t = useTranslations('users');
  return (
    <Tr>
      <th scope="row" className="px-3.5 py-3 text-left font-normal">
        <span className="flex items-center gap-3">
          <Avatar name={member.name} />
          <span className="flex min-w-0 flex-col">
            <Link
              href={userDetailPath(member.userId)}
              className="font-bold text-foreground underline-offset-2 hover:underline"
            >
              {member.name}
            </Link>
            <span className="text-xs break-all text-muted-foreground">{member.email}</span>
          </span>
        </span>
      </th>
      <Td className="hidden md:table-cell">{member.jobTitle ?? t('detail.none')}</Td>
      <Td className="hidden lg:table-cell">{departmentName}</Td>
      <Td className="hidden md:table-cell">{t(`types.${member.type}`)}</Td>
      <Td>
        <StatusBadge membership={member} />
      </Td>
      <Td className="w-12 py-1.5 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('directory.menu', { name: member.name })}
              className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
            >
              <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={userDetailPath(member.userId)}>{t('directory.open')}</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Td>
    </Tr>
  );
}
