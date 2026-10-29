'use client';

import {
  Alert,
  Button,
  Combobox,
  DateRangePicker,
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
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
  TriangleAlert,
  ViewTabs,
  fromIsoDate,
  toIsoDate,
} from '@contrataflow/ui';
import type { DateRange, FilterToolbarChip } from '@contrataflow/ui';
import {
  APPROVAL_LIST_QUERY_LIMITS,
  APPROVAL_STATUSES,
  APPROVAL_SUBJECT_TYPES,
  formatApprovalListSort,
} from '@contrataflow/validation';
import type {
  ApprovalListItemDto,
  ApprovalListSort,
  ApprovalStatus,
  ApprovalSubjectType,
} from '@contrataflow/validation';
import { useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { AppPageHeader } from '@/components/shell/page-header';
import { ApprovalStatusBadge } from '@/features/approval-decision/approval-status-badge';
import { ConfidentialBadge } from '@/features/process-list/process-list-badges';
import {
  FILTER_OPTIONS_STALE_TIME_MS,
  fetchUnitOptions,
  processListKeys,
} from '@/features/process-list/process-list.api';
import { useTenantId } from '@/lib/session/session-context';

import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  activeRefinements,
  approvalListQuery,
  describeLoadError,
  effectiveSearch,
  isPeriodValid,
  parseSortOption,
  sortOptions,
  statusTabOf,
  tabCountQuery,
} from './approval-list-model';
import type { ApprovalFilters } from './approval-list-model';
import { approvalListKeys, fetchApprovalList, useApprovalList } from './approval-list.api';

/** "Todos" no `Select` de tipo de assunto (o Radix não aceita valor vazio). */
const ANY = '__any__';
const SEARCH_DEBOUNCE_MS = 300;
const PANEL_ID = 'aprovacoes-situacao';

/**
 * SCR-014 — Aprovações (US-057) no modelo `ListPage` (prd-5): as aprovações da cobertura do usuário
 * (APV-01 — POL-03 aplicada pela API como filtro), com a situação em abas com contadores, busca
 * inline, tipo de assunto, unidade solicitante e período num popover (chips do que está ativo),
 * ordenação e paginação. Cada linha só navega (RN-INBOX-17): a decisão é no SCR-015.
 */
export function ApprovalListPage() {
  const t = useTranslations('approvalList');
  const tenantId = useTenantId();
  const [filters, setFilters] = useState<ApprovalFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<ApprovalListSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const periodValid = isPeriodValid(filters);
  const list = useApprovalList(approvalListQuery(filters, sort, page), periodValid);
  const status = statusTabOf(filters);

  const change = (next: ApprovalFilters) => {
    setFilters(next);
    setPage(1);
  };

  // Busca inline: 300 ms sem digitação; menos de 2 caracteres não filtra (V-03).
  const [searchText, setSearchText] = useState(filters.q);
  const lastQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== lastQ.current) {
      lastQ.current = filters.q;
      setSearchText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    if (searchText === filters.q) return undefined;
    const timer = setTimeout(() => {
      lastQ.current = searchText;
      change({ ...filters, q: searchText });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage só ao texto digitado
  }, [searchText]);

  // Contadores das abas: o total de cada situação com os demais filtros; a aba ativa usa o da lista.
  const counted = APPROVAL_STATUSES.filter((candidate) => candidate !== status);
  const tabCounts = useQueries({
    queries: counted.map((candidate) => {
      const query = tabCountQuery(filters, candidate);
      return {
        queryKey: approvalListKeys.list(tenantId, query),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await fetchApprovalList(query, signal)).meta.totalItems,
        enabled: periodValid,
        refetchOnWindowFocus: true,
        throwOnError: false,
        retry: false,
      };
    }),
  });
  const countOf = (candidate: ApprovalStatus): number | undefined =>
    candidate === status ? list.data?.meta.totalItems : tabCounts[counted.indexOf(candidate)]?.data;

  const units = useQuery({
    queryKey: processListKeys.departments(tenantId),
    queryFn: ({ signal }) => fetchUnitOptions(signal),
    staleTime: FILTER_OPTIONS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });

  const data = list.data;
  const items = data?.items ?? [];
  const refined = activeRefinements(filters).length > 0;
  const clear = () => {
    change({ ...DEFAULT_FILTERS, statuses: filters.statuses });
    setSearchText('');
  };

  return (
    <ListPage
      header={<AppPageHeader title={t('title')} description={t('description')} />}
      tabs={
        <ViewTabs
          label={t('tabs.label')}
          value={status}
          panelId={PANEL_ID}
          onValueChange={(id) => {
            change({ ...filters, statuses: [id as ApprovalStatus] });
          }}
          tabs={APPROVAL_STATUSES.map((candidate) => {
            const label = t(`tabs.${candidate}`);
            const count = countOf(candidate);
            return {
              id: candidate,
              label,
              count,
              accessibleLabel:
                count === undefined ? undefined : t('tabs.countLabel', { label, count }),
            };
          })}
        />
      }
      toolbar={
        <ApprovalToolbar
          filters={filters}
          searchText={searchText}
          onSearch={setSearchText}
          units={units.data ?? []}
          sort={sort}
          onChange={change}
          onClear={clear}
          onSort={(next) => {
            setSort(next);
            setPage(1);
          }}
        />
      }
      notices={
        periodValid ? null : (
          <p role="alert" className="text-sm font-semibold text-destructive">
            {t('filters.invalidPeriod')}
          </p>
        )
      }
      error={
        list.isError ? (
          <LoadError
            error={list.error}
            onRetry={() => void list.refetch()}
            onClearDepartment={() => {
              change({ ...filters, requestingDepartmentId: '' });
            }}
            compact={data !== undefined}
          />
        ) : null
      }
      loading={list.isPending && !list.isError}
      loadingLabel={t('loading')}
    >
      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-label={t(`tabs.${status}`)}
        className="flex min-w-0 flex-col gap-3"
      >
        {list.isFetching && data ? (
          <div
            role="progressbar"
            aria-label={t('refreshing')}
            className="h-1 w-full animate-pulse rounded bg-primary/40"
          />
        ) : null}
        {data === undefined ? null : items.length === 0 ? (
          <ApprovalEmpty
            status={status}
            refined={refined}
            onClear={clear}
            onSeeDone={() => {
              change({ ...filters, statuses: ['APPROVED'] });
            }}
          />
        ) : (
          <TableContainer
            label={t('table.caption')}
            footer={
              <TableFooter summary={t('footer.count', { count: data.meta.totalItems })}>
                {data.meta.totalPages > 1 ? (
                  <nav aria-label={t('pagination.label')} className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={data.meta.page <= 1}
                      onClick={() => {
                        setPage(data.meta.page - 1);
                      }}
                    >
                      {t('pagination.previous')}
                    </Button>
                    <span>
                      {t('pagination.status', {
                        page: data.meta.page,
                        total: data.meta.totalPages,
                      })}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={data.meta.page >= data.meta.totalPages}
                      onClick={() => {
                        setPage(data.meta.page + 1);
                      }}
                    >
                      {t('pagination.next')}
                    </Button>
                  </nav>
                ) : null}
              </TableFooter>
            }
          >
            <ApprovalTable items={items} />
          </TableContainer>
        )}
      </div>
    </ListPage>
  );
}

/** Busca inline, popover (tipo de assunto, unidade solicitante, período), chips e ordenação. */
function ApprovalToolbar({
  filters,
  searchText,
  onSearch,
  units,
  sort,
  onChange,
  onClear,
  onSort,
}: {
  readonly filters: ApprovalFilters;
  readonly searchText: string;
  readonly onSearch: (text: string) => void;
  readonly units: readonly { readonly id: string; readonly name: string }[];
  readonly sort: ApprovalListSort;
  readonly onChange: (filters: ApprovalFilters) => void;
  readonly onClear: () => void;
  readonly onSort: (sort: ApprovalListSort) => void;
}) {
  const t = useTranslations('approvalList');
  const tSort = useTranslations('approvalList.sort');
  const format = useFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short', timeZone: 'UTC' });
  const period: DateRange | undefined =
    filters.requestedFrom === '' && filters.requestedTo === ''
      ? undefined
      : { from: fromIsoDate(filters.requestedFrom), to: fromIsoDate(filters.requestedTo) };
  const searchTooShort = searchText.trim() !== '' && effectiveSearch(searchText) === undefined;

  const chipOf = (
    key: ReturnType<typeof activeRefinements>[number],
  ): { label: string; value: string; next: ApprovalFilters } | null => {
    switch (key) {
      case 'subjectType':
        return filters.subjectType === ''
          ? null
          : {
              label: t('filters.subjectType'),
              value: t(`subjectType.${filters.subjectType}`),
              next: { ...filters, subjectType: '' },
            };
      case 'requestingDepartmentId':
        return {
          label: t('filters.department'),
          value: units.find((unit) => unit.id === filters.requestingDepartmentId)?.name ?? '…',
          next: { ...filters, requestingDepartmentId: '' },
        };
      case 'period':
        return {
          label: t('filters.period'),
          value: [filters.requestedFrom, filters.requestedTo]
            .filter((value) => value !== '')
            .map(date)
            .join(` ${t('filters.periodSeparator')} `),
          next: { ...filters, requestedFrom: '', requestedTo: '' },
        };
      case 'q':
        return null;
    }
  };
  const popoverKeys = activeRefinements(filters).filter((key) => key !== 'q');
  const chips: FilterToolbarChip[] = popoverKeys.flatMap((key) => {
    const chip = chipOf(key);
    if (chip === null) return [];
    return [
      {
        id: key,
        label: t('filters.chip', { label: chip.label, value: chip.value }),
        removeLabel: t('filters.remove', { label: `${chip.label}: ${chip.value}` }),
        onRemove: () => {
          onChange(chip.next);
        },
      },
    ];
  });

  return (
    <FilterToolbar
      search={{
        value: searchText,
        onChange: (text) => {
          onSearch(text.slice(0, APPROVAL_LIST_QUERY_LIMITS.qMax));
        },
        label: t('filters.search'),
        placeholder: t('filters.searchPlaceholder'),
        description: searchTooShort ? t('filters.searchTooShort') : undefined,
      }}
      filters={
        <>
          <Field label={t('filters.subjectType')}>
            <Select
              value={filters.subjectType === '' ? ANY : filters.subjectType}
              onValueChange={(value) => {
                onChange({
                  ...filters,
                  subjectType: value === ANY ? '' : (value as ApprovalSubjectType),
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t('filters.any')}</SelectItem>
                {APPROVAL_SUBJECT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`subjectType.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('filters.department')}>
            <Combobox
              clearable
              options={units.map((unit) => ({ value: unit.id, label: unit.name }))}
              value={filters.requestingDepartmentId}
              onValueChange={(value) => {
                onChange({ ...filters, requestingDepartmentId: value ?? '' });
              }}
              labels={{
                placeholder: t('filters.anyDepartment'),
                search: t('filters.departmentSearch'),
                empty: t('filters.departmentEmpty'),
              }}
            />
          </Field>
          <Field label={t('filters.period')}>
            <DateRangePicker
              clearable
              numberOfMonths={1}
              value={period}
              onValueChange={(range) => {
                onChange({
                  ...filters,
                  requestedFrom: range?.from ? toIsoDate(range.from) : '',
                  requestedTo: range?.to ? toIsoDate(range.to) : '',
                });
              }}
              labels={{
                placeholder: t('filters.periodPlaceholder'),
                clear: t('filters.periodClear'),
                calendar: t('filters.periodCalendar'),
                separator: t('filters.periodSeparator'),
              }}
            />
          </Field>
        </>
      }
      activeCount={popoverKeys.length}
      chips={chips}
      onClearAll={onClear}
      sort={{
        value: formatApprovalListSort(sort),
        onValueChange: (value) => {
          onSort(parseSortOption(value));
        },
        options: sortOptions().map((option) => ({
          value: option,
          label: tSort(option as Parameters<typeof tSort>[0]),
        })),
      }}
      labels={{
        filters: t('filters.open'),
        clearAll: t('filters.clear'),
        sort: tSort('label'),
        activeFilters: t('filters.active'),
      }}
    />
  );
}

/** FA-01 ("você está em dia") só na aba Pendentes sem filtros; FA-05 oferece "Limpar filtros". */
function ApprovalEmpty({
  status,
  refined,
  onClear,
  onSeeDone,
}: {
  readonly status: ApprovalStatus;
  readonly refined: boolean;
  readonly onClear: () => void;
  readonly onSeeDone: () => void;
}) {
  const t = useTranslations('approvalList.empty');
  if (refined) {
    return (
      <EmptyState
        title={t('filtered')}
        action={
          <Button variant="secondary" onClick={onClear}>
            {t('clear')}
          </Button>
        }
      />
    );
  }
  if (status === 'PENDING') {
    return (
      <EmptyState
        title={t('pendingTitle')}
        description={t('pendingDescription')}
        action={
          <Button variant="secondary" onClick={onSeeDone}>
            {t('seeDone')}
          </Button>
        }
      />
    );
  }
  return <EmptyState title={t(`status.${status}`)} />;
}

function LoadError({
  error,
  onRetry,
  onClearDepartment,
  compact = false,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly onClearDepartment: () => void;
  readonly compact?: boolean;
}) {
  const t = useTranslations('approvalList.errors');
  const problem = describeLoadError(error);
  const title =
    problem.kind === 'unexpected'
      ? t('unexpected', { correlationId: problem.correlationId })
      : t(problem.kind);
  return (
    <Alert tone="error" title={title} live={!compact}>
      <div className="flex flex-col gap-2">
        {problem.kind === 'unexpected' ? (
          <CorrelationCode
            correlationId={problem.correlationId}
            labels={{
              code: t('code', { correlationId: problem.correlationId }),
              copy: t('copy'),
              copied: t('copied'),
            }}
          />
        ) : null}
        <div>
          {problem.kind === 'invalidDepartment' ? (
            <Button variant="secondary" size="sm" onClick={onClearDepartment}>
              {t('clearDepartment')}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          )}
        </div>
      </div>
    </Alert>
  );
}

const CELL = 'max-md:p-0';

/** Seis colunas (prd-5 · regra 3): processo, assunto, solicitante, data, prazo e situação. */
function ApprovalTable({ items }: { readonly items: readonly ApprovalListItemDto[] }) {
  const t = useTranslations('approvalList');
  const format = useFormatter();
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'short' });
  return (
    <Table className="md:min-w-[60rem]">
      <caption className="sr-only">{t('table.caption')}</caption>
      <TableHead className="max-md:sr-only">
        <Tr>
          <Th>{t('table.process')}</Th>
          <Th>{t('table.approval')}</Th>
          <Th>{t('table.requestedBy')}</Th>
          <Th>{t('table.requestedAt')}</Th>
          <Th>{t('table.dueAt')}</Th>
          <Th>{t('table.status')}</Th>
          <Th className="w-14">
            <span className="sr-only">{t('table.actionsColumn')}</span>
          </Th>
        </Tr>
      </TableHead>
      <TableBody>
        {items.map((item) => {
          const code = item.process.code ?? t('table.noCode');
          return (
            <Tr
              key={item.id}
              className="max-md:relative max-md:flex max-md:flex-col max-md:gap-1.5 max-md:p-4 max-md:pr-14"
            >
              <Td className={CELL}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-bold break-words text-brand-ink">{item.process.title}</span>
                  <Link
                    href={`/processos/${item.process.id}`}
                    className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                  >
                    {code}
                  </Link>
                  {item.isBudgetConfidential ? (
                    <span className="mt-1">
                      <ConfidentialBadge />
                    </span>
                  ) : null}
                </div>
              </Td>
              <Td className={CELL}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/aprovacoes/${item.id}`}
                    className="w-fit font-semibold break-words text-primary-soft-foreground underline-offset-2 hover:underline"
                    aria-label={t('table.open', { title: item.title, code })}
                  >
                    {item.title}
                  </Link>
                  <span className="text-xs break-words text-muted-foreground">
                    {t(`subjectType.${item.subjectType}`)} · {item.approver.label}
                  </span>
                </div>
              </Td>
              <Td className={CELL}>
                <span className="md:sr-only">{t('table.requestedBy')}: </span>
                <span className="inline-flex flex-col">
                  <span>{item.requestedBy.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.requestingDepartment.name}
                  </span>
                </span>
              </Td>
              <Td className={`${CELL} whitespace-nowrap`}>
                <span className="md:sr-only">{t('table.requestedAt')}: </span>
                {date(item.requestedAt)}
              </Td>
              <Td className={CELL}>
                <span className="md:sr-only">{t('table.dueAt')}: </span>
                {item.isOverdue ? (
                  <StatusChip tone="danger" icon={<TriangleAlert aria-hidden="true" />}>
                    {t('table.overdue')}
                    {item.dueAt === null ? null : ` · ${date(item.dueAt)}`}
                  </StatusChip>
                ) : item.dueAt === null ? (
                  <span className="text-muted-foreground">{t('table.noDueAt')}</span>
                ) : (
                  date(item.dueAt)
                )}
              </Td>
              <Td className={CELL}>
                <ApprovalStatusBadge status={item.status} />
              </Td>
              <Td className="text-right max-md:absolute max-md:top-2 max-md:right-2 max-md:p-0">
                <RowMenu item={item} />
              </Td>
            </Tr>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Menu ⋯ da linha: só navegação (RN-INBOX-17) — a aprovação e o processo. */
function RowMenu({ item }: { readonly item: ApprovalListItemDto }) {
  const t = useTranslations('approvalList.table');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('actions', { title: item.title })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/aprovacoes/${item.id}`}>{t('openApproval')}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/processos/${item.process.id}`}>{t('openProcess')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
