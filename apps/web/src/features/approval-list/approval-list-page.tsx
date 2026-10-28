'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import {
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
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { AppPageHeader } from '@/components/shell/page-header';
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
  approvalListQuery,
  describeLoadError,
  hasActiveFilters,
  isPeriodValid,
  parseSortOption,
  sortOptions,
} from './approval-list-model';
import type { ApprovalFilters } from './approval-list-model';
import { useApprovalList } from './approval-list.api';

/**
 * SCR-014 — Aprovações (US-057): as aprovações da cobertura do usuário (APV-01 — POL-03 aplicada
 * pela API como filtro), com filtros por status, tipo, unidade solicitante, período e busca,
 * ordenação e paginação. Cada linha só navega (RN-INBOX-17): a decisão é no SCR-015.
 */
export function ApprovalListPage() {
  const t = useTranslations('approvalList');
  const [filters, setFilters] = useState<ApprovalFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<ApprovalListSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  // "Limpar filtros" também zera a busca digitada (estado local do formulário).
  const [formKey, setFormKey] = useState(0);
  const periodValid = isPeriodValid(filters);
  const list = useApprovalList(approvalListQuery(filters, sort, page), periodValid);

  const change = (next: ApprovalFilters) => {
    setFilters(next);
    setPage(1);
  };

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <AppPageHeader title={t('title')} description={t('description')} />
      <ApprovalFiltersForm
        key={formKey}
        filters={filters}
        periodValid={periodValid}
        onChange={change}
      />
      <div className="flex min-w-0 flex-col gap-3">
        <SortSelect
          sort={sort}
          onChange={(next) => {
            setSort(next);
            setPage(1);
          }}
        />
        <ApprovalResults
          query={list}
          filtered={hasActiveFilters(filters)}
          onClear={() => {
            change(DEFAULT_FILTERS);
            setFormKey((key) => key + 1);
          }}
          onClearDepartment={() => {
            change({ ...filters, requestingDepartmentId: '' });
          }}
          onPage={setPage}
        />
      </div>
    </section>
  );
}

function ApprovalFiltersForm({
  filters,
  periodValid,
  onChange,
}: {
  readonly filters: ApprovalFilters;
  readonly periodValid: boolean;
  readonly onChange: (filters: ApprovalFilters) => void;
}) {
  const t = useTranslations('approvalList.filters');
  const tStatus = useTranslations('approvalList.status');
  const tSubject = useTranslations('approvalList.subjectType');
  const tenantId = useTenantId();
  const ids = useId();
  const [search, setSearch] = useState(filters.q);
  const units = useQuery({
    queryKey: processListKeys.departments(tenantId),
    queryFn: ({ signal }) => fetchUnitOptions(signal),
    staleTime: FILTER_OPTIONS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });

  const toggleStatus = (status: ApprovalStatus, checked: boolean) => {
    const statuses = checked
      ? APPROVAL_STATUSES.filter((value) => value === status || filters.statuses.includes(value))
      : filters.statuses.filter((value) => value !== status);
    onChange({ ...filters, statuses });
  };
  const submitSearch = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onChange({ ...filters, q: search });
  };
  const periodErrorId = `${ids}-period-error`;

  return (
    <form
      role="search"
      aria-label={t('label')}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card"
      onSubmit={submitSearch}
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <fieldset className="flex flex-col gap-1 md:col-span-2">
          <legend className="text-sm font-medium">{t('status')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {APPROVAL_STATUSES.map((status) => (
              <label key={status} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.statuses.includes(status)}
                  onChange={(event) => {
                    toggleStatus(status, event.target.checked);
                  }}
                />
                {tStatus(status)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('subjectType')}
          <select
            className="rounded-control border border-border bg-surface px-2 py-1 font-normal"
            value={filters.subjectType}
            onChange={(event) => {
              onChange({ ...filters, subjectType: event.target.value as ApprovalSubjectType | '' });
            }}
          >
            <option value="">{t('any')}</option>
            {APPROVAL_SUBJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {tSubject(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('department')}
          <select
            className="rounded-control border border-border bg-surface px-2 py-1 font-normal"
            value={filters.requestingDepartmentId}
            onChange={(event) => {
              onChange({ ...filters, requestingDepartmentId: event.target.value });
            }}
          >
            <option value="">{t('anyDepartment')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('requestedFrom')}
          <input
            type="date"
            className="rounded-control border border-border bg-surface px-2 py-1 font-normal"
            value={filters.requestedFrom}
            aria-invalid={!periodValid}
            aria-describedby={periodValid ? undefined : periodErrorId}
            onChange={(event) => {
              onChange({ ...filters, requestedFrom: event.target.value });
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('requestedTo')}
          <input
            type="date"
            className="rounded-control border border-border bg-surface px-2 py-1 font-normal"
            value={filters.requestedTo}
            aria-invalid={!periodValid}
            aria-describedby={periodValid ? undefined : periodErrorId}
            onChange={(event) => {
              onChange({ ...filters, requestedTo: event.target.value });
            }}
          />
        </label>
        <div className="flex flex-col gap-1 md:col-span-2">
          <label htmlFor={`${ids}-q`} className="text-sm font-medium">
            {t('search')}
          </label>
          <div className="flex gap-2">
            <input
              id={`${ids}-q`}
              type="search"
              className="min-w-0 flex-1 rounded-control border border-border bg-surface px-2 py-1"
              placeholder={t('searchPlaceholder')}
              value={search}
              maxLength={200}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
            <Button type="submit" variant="secondary" size="sm">
              {t('apply')}
            </Button>
          </div>
        </div>
      </div>
      {periodValid ? null : (
        <p id={periodErrorId} role="alert" className="text-sm text-destructive">
          {t('invalidPeriod')}
        </p>
      )}
    </form>
  );
}

function SortSelect({
  sort,
  onChange,
}: {
  readonly sort: ApprovalListSort;
  readonly onChange: (sort: ApprovalListSort) => void;
}) {
  const t = useTranslations('approvalList.sort');
  return (
    <label className="flex flex-wrap items-center gap-2 self-end text-sm">
      {t('label')}
      <select
        className="rounded-control border border-border bg-surface px-2 py-1"
        value={formatApprovalListSort(sort)}
        onChange={(event) => {
          onChange(parseSortOption(event.target.value));
        }}
      >
        {sortOptions().map((option) => (
          <option key={option} value={option}>
            {t(option as Parameters<typeof t>[0])}
          </option>
        ))}
      </select>
    </label>
  );
}

function ApprovalResults({
  query,
  filtered,
  onClear,
  onClearDepartment,
  onPage,
}: {
  readonly query: ReturnType<typeof useApprovalList>;
  readonly filtered: boolean;
  readonly onClear: () => void;
  readonly onClearDepartment: () => void;
  readonly onPage: (page: number) => void;
}) {
  const t = useTranslations('approvalList');
  const data = query.data;
  const items = data?.items ?? [];

  if (query.isError && !data) {
    return (
      <LoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        onClearDepartment={onClearDepartment}
      />
    );
  }
  if (query.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <>
      {query.isError ? (
        <LoadError
          error={query.error}
          onRetry={() => void query.refetch()}
          onClearDepartment={onClearDepartment}
          compact
        />
      ) : null}
      {query.isFetching ? (
        <div
          role="progressbar"
          aria-label={t('refreshing')}
          className="h-1 w-full animate-pulse rounded bg-primary/40"
        />
      ) : null}
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{filtered ? t('empty.filtered') : t('empty.pending')}</p>
          {filtered ? (
            <Button variant="secondary" size="sm" onClick={onClear}>
              {t('empty.clear')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ApprovalTable items={items} />
      )}
      {data && data.meta.totalPages > 1 ? (
        <nav aria-label={t('pagination.label')} className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={data.meta.page <= 1}
            onClick={() => {
              onPage(data.meta.page - 1);
            }}
          >
            {t('pagination.previous')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('pagination.status', { page: data.meta.page, total: data.meta.totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={data.meta.page >= data.meta.totalPages}
            onClick={() => {
              onPage(data.meta.page + 1);
            }}
          >
            {t('pagination.next')}
          </Button>
        </nav>
      ) : null}
    </>
  );
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

function ApprovalTable({ items }: { readonly items: readonly ApprovalListItemDto[] }) {
  const t = useTranslations('approvalList');
  const format = useFormatter();
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'short' });
  return (
    <div className="relative rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
      <table className="w-full text-left text-sm md:min-w-[56rem]">
        <caption className="sr-only">{t('table.caption')}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('table.approval')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.department')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.requestedBy')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.requestedAt')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.dueAt')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="border-t border-border max-md:flex max-md:flex-col max-md:gap-1 max-md:p-3"
            >
              <td className="px-3 py-2 align-top max-md:p-0">
                <Link
                  href={`/aprovacoes/${item.id}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  aria-label={t('table.open', {
                    title: item.title,
                    code: item.process.code ?? t('table.noCode'),
                  })}
                >
                  {item.title}
                </Link>
                <p className="text-foreground">
                  <Link
                    href={`/processos/${item.process.id}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {item.process.code ?? t('table.noCode')}
                  </Link>{' '}
                  — {item.process.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`subjectType.${item.subjectType}`)} · {item.approver.label}
                </p>
                {item.isBudgetConfidential ? (
                  <div className="mt-1">
                    <ConfidentialBadge />
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.department')}: </span>
                {item.requestingDepartment.name}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.requestedBy')}: </span>
                {item.requestedBy.name}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.requestedAt')}: </span>
                {date(item.requestedAt)}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.dueAt')}: </span>
                <span className="inline-flex flex-wrap items-center gap-1">
                  {item.dueAt === null ? t('table.noDueAt') : date(item.dueAt)}
                  {item.isOverdue ? <OverdueBadge /> : null}
                </span>
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.status')}: </span>
                {t(`status.${item.status}`)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Selo "Em atraso" (RN-INBOX-16): sempre ícone + texto, nunca só cor. */
function OverdueBadge() {
  const t = useTranslations('approvalList.table');
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-destructive-soft px-2 py-0.5 text-xs font-medium text-destructive">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        <path d="M8 1 15 14H1L8 1Zm-.75 5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z" />
      </svg>
      {t('overdue')}
    </span>
  );
}
