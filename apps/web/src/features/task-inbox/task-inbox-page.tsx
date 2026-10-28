'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import type { TaskInboxItemDto, TaskInboxSort, TaskInboxView } from '@contrataflow/validation';
import { formatTaskInboxSort } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { AppPageHeader } from '@/components/shell/page-header';
import { claimProcess } from '@/features/process-claim/process-claim.api';
import { ConfidentialBadge, DueDateBadge } from '@/features/process-list/process-list-badges';
import {
  hasPermission,
  useEffectivePermissions,
  usePermission,
} from '@/lib/permissions/use-permission';
import { tenantKey } from '@/lib/query/keys';
import { useTenantId } from '@/lib/session/session-context';

import { TaskBulkActions } from './task-bulk-actions';
import {
  EMPTY_SELECTION,
  isFull,
  isSelectable,
  selectedItemOf,
  togglePage,
  toggleSelection,
} from './task-bulk-model';
import type { BulkSelection } from './task-bulk-model';
import {
  DEFAULT_SORT,
  counterOf,
  describeLoadError,
  describeQuickClaimError,
  parseSortOption,
  sortForView,
  sortOptions,
  visibleTabs,
} from './task-inbox-model';
import { useTaskInbox, useTaskInboxCounters } from './task-inbox.api';

/** Seleção múltipla da fila da unidade (US-058): só existe com alguma ação em lote disponível. */
interface BulkSelectionControl {
  readonly selection: BulkSelection;
  readonly onChange: (selection: BulkSelection) => void;
}

/**
 * SCR-013 — Caixa de tarefas (US-056): abas com contadores (TSK-02), a lista da aba ativa (TSK-01)
 * com ordenação e paginação, a ação rápida "Assumir" (PRC-21) na fila da unidade e o polling de
 * 60 s (RN-INBOX-13). Acesso por `INBOX_VIEW`; a API decide cada requisição. Na fila da unidade,
 * a seleção múltipla e as ações em lote (US-058 · TSK-03/TSK-04): "Assumir selecionados" com
 * `PROCESS_CLAIM`; "Atribuir selecionados" com `PROCESS_ASSIGN` ou chefia de unidade.
 */
export function TaskInboxPage() {
  const t = useTranslations('taskInbox');
  const { allowed, status } = usePermission('INBOX_VIEW');
  const [view, setView] = useState<TaskInboxView>('MINE');
  const [sort, setSort] = useState<TaskInboxSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [announcement, setAnnouncement] = useState('');
  const counters = useTaskInboxCounters(allowed);
  const list = useTaskInbox(view, sort, page, allowed);
  const tabs = visibleTabs(counters.data);
  const effective = useEffectivePermissions().data;
  const canBulkClaim = hasPermission(effective, 'PROCESS_CLAIM');
  const canBulkAssign =
    hasPermission(effective, 'PROCESS_ASSIGN') ||
    (effective?.implicit.headOfDepartmentIds.length ?? 0) > 0;
  const [selection, setSelection] = useState<BulkSelection>(EMPTY_SELECTION);
  const bulk: BulkSelectionControl | null =
    view === 'UNIT_QUEUE' && (canBulkClaim || canBulkAssign)
      ? { selection, onChange: setSelection }
      : null;

  const select = (next: TaskInboxView) => {
    setView(next);
    setSelection(EMPTY_SELECTION);
    setSort((current) => sortForView(current, next));
    // A página só vale dentro da aba (RN-INBOX-10); a ordenação é mantida.
    setPage(1);
    const count = counterOf(counters.data, next);
    if (count !== undefined) {
      setAnnouncement(t('tabs.announce', { label: t(`tabs.${next}`), count }));
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <AppPageHeader title={t('title')} description={t('description')} />

      {status === 'pending' ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">{t('loadingPermission')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {status !== 'pending' && !allowed ? (
        <Alert tone="error" title={t('forbidden.title')}>
          {t('forbidden.description')}
        </Alert>
      ) : null}

      {allowed ? (
        <div className="flex min-w-0 flex-col gap-4">
          <InboxTabs
            tabs={tabs}
            active={view}
            counters={counters.data}
            loading={counters.isPending}
            onSelect={select}
          />
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
          <div
            role="tabpanel"
            id={`inbox-panel-${view}`}
            aria-labelledby={`inbox-tab-${view}`}
            className="flex min-w-0 flex-col gap-3"
          >
            <SortSelect
              view={view}
              sort={sort}
              onChange={(next) => {
                setSort(next);
                setPage(1);
              }}
            />
            {bulk === null ? null : (
              <TaskBulkActions
                selection={selection}
                canClaim={canBulkClaim}
                canAssign={canBulkAssign}
                onClear={() => {
                  setSelection(EMPTY_SELECTION);
                }}
                onProcessed={(succeeded) => {
                  setSelection((current) => {
                    const next = new Map(current);
                    for (const id of succeeded) next.delete(id);
                    return next;
                  });
                }}
              />
            )}
            <InboxList
              view={view}
              bulk={bulk}
              query={list}
              onPage={setPage}
              onRetry={() => {
                void list.refetch();
                void counters.refetch();
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function InboxTabs({
  tabs,
  active,
  counters,
  loading,
  onSelect,
}: {
  readonly tabs: readonly TaskInboxView[];
  readonly active: TaskInboxView;
  readonly counters: Parameters<typeof counterOf>[0];
  readonly loading: boolean;
  readonly onSelect: (view: TaskInboxView) => void;
}) {
  const t = useTranslations('taskInbox.tabs');
  const refs = useRef<Partial<Record<TaskInboxView, HTMLButtonElement | null>>>({});
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(active);
    const target =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target);
    refs.current[target]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map((view) => {
        const selected = view === active;
        const count = counterOf(counters, view);
        const label = t(view);
        return (
          <button
            key={view}
            ref={(element) => {
              refs.current[view] = element;
            }}
            type="button"
            role="tab"
            id={`inbox-tab-${view}`}
            aria-selected={selected}
            aria-controls={`inbox-panel-${view}`}
            aria-label={count === undefined ? label : t('countLabel', { label, count })}
            tabIndex={selected ? 0 : -1}
            className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => {
              onSelect(view);
            }}
            onKeyDown={moveFocus}
          >
            {label}
            {count === undefined ? (
              loading ? (
                <Skeleton className="h-4 w-5" />
              ) : null
            ) : (
              <span
                aria-hidden="true"
                className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${
                  view === 'OVERDUE' && count > 0
                    ? 'bg-destructive-soft text-destructive'
                    : 'bg-muted text-foreground'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SortSelect({
  view,
  sort,
  onChange,
}: {
  readonly view: TaskInboxView;
  readonly sort: TaskInboxSort;
  readonly onChange: (sort: TaskInboxSort) => void;
}) {
  const t = useTranslations('taskInbox.sort');
  return (
    <label className="flex flex-wrap items-center gap-2 self-end text-sm">
      {t('label')}
      <select
        className="rounded-control border border-border bg-surface px-2 py-1"
        value={formatTaskInboxSort(sort)}
        onChange={(event) => {
          onChange(parseSortOption(event.target.value, view));
        }}
      >
        {sortOptions(view).map((option) => (
          <option key={option} value={option}>
            {t(option as Parameters<typeof t>[0])}
          </option>
        ))}
      </select>
    </label>
  );
}

function InboxList({
  view,
  bulk,
  query,
  onPage,
  onRetry,
}: {
  readonly view: TaskInboxView;
  readonly bulk: BulkSelectionControl | null;
  readonly query: ReturnType<typeof useTaskInbox>;
  readonly onPage: (page: number) => void;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('taskInbox');
  const data = query.data;
  const items = data?.items ?? [];

  if (query.isError && !data) return <LoadError error={query.error} onRetry={onRetry} />;
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
      {query.isError ? <LoadError error={query.error} onRetry={onRetry} compact /> : null}
      {query.isFetching ? (
        <div
          role="progressbar"
          aria-label={t('refreshing')}
          className="h-1 w-full animate-pulse rounded bg-primary/40"
        />
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t(`empty.${view}`)}</p>
        </div>
      ) : (
        <InboxTable view={view} items={items} bulk={bulk} />
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
  compact = false,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly compact?: boolean;
}) {
  const t = useTranslations('taskInbox.errors');
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
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

function InboxTable({
  view,
  items,
  bulk,
}: {
  readonly view: TaskInboxView;
  readonly items: readonly TaskInboxItemDto[];
  readonly bulk: BulkSelectionControl | null;
}) {
  const t = useTranslations('taskInbox');
  const format = useFormatter();
  const approvals = view === 'PENDING_APPROVALS';
  const queue = view === 'UNIT_QUEUE';
  const selectable = bulk === null ? [] : items.filter(isSelectable).map(selectedItemOf);
  const pageSelected =
    bulk !== null &&
    selectable.length > 0 &&
    selectable.every((item) => bulk.selection.has(item.processId));
  return (
    <div className="rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
      <table className="w-full text-left text-sm md:min-w-[48rem]">
        <caption className="sr-only">{t('table.caption', { view: t(`tabs.${view}`) })}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
          <tr>
            {bulk === null ? null : (
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  className="size-4"
                  aria-label={t('bulk.selectPage')}
                  checked={pageSelected}
                  disabled={selectable.length === 0}
                  onChange={() => {
                    bulk.onChange(togglePage(bulk.selection, selectable));
                  }}
                />
              </th>
            )}
            <th scope="col" className="px-3 py-2">
              {t('table.process')}
            </th>
            {approvals ? (
              <>
                <th scope="col" className="px-3 py-2">
                  {t('table.requestedBy')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('table.requestedAt')}
                </th>
              </>
            ) : null}
            <th scope="col" className="px-3 py-2">
              {t('table.stage')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.department')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.responsible')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.deadline')}
            </th>
            {queue ? (
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="border-t border-border max-md:flex max-md:flex-col max-md:gap-1 max-md:p-3"
            >
              {bulk === null ? null : (
                <td className="px-3 py-2 align-top max-md:p-0">
                  {isSelectable(item) ? (
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={t('bulk.selectRow', { code: item.code ?? item.title })}
                      checked={bulk.selection.has(item.processId)}
                      disabled={!bulk.selection.has(item.processId) && isFull(bulk.selection)}
                      onChange={() => {
                        bulk.onChange(toggleSelection(bulk.selection, selectedItemOf(item)));
                      }}
                    />
                  ) : null}
                </td>
              )}
              <td className="px-3 py-2 align-top max-md:p-0">
                <Link
                  href={`/processos/${item.processId}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {item.code ?? t('table.noCode')}
                </Link>
                <p className="text-foreground">{item.title}</p>
                {item.approval ? (
                  <p className="text-xs text-muted-foreground">{item.approval.title}</p>
                ) : null}
                {item.isBudgetConfidential ? (
                  <div className="mt-1">
                    <ConfidentialBadge />
                  </div>
                ) : null}
              </td>
              {approvals ? (
                <>
                  <td className="px-3 py-2 align-top max-md:p-0">
                    <span className="md:sr-only">{t('table.requestedBy')}: </span>
                    {item.approval?.requestedBy.name}
                  </td>
                  <td className="px-3 py-2 align-top max-md:p-0">
                    <span className="md:sr-only">{t('table.requestedAt')}: </span>
                    {item.approval
                      ? format.dateTime(new Date(item.approval.requestedAt), {
                          dateStyle: 'short',
                        })
                      : null}
                  </td>
                </>
              ) : null}
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.stage')}: </span>
                {item.currentStage?.name ?? t('table.noStage')}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.department')}: </span>
                {item.currentDepartment.name}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <span className="md:sr-only">{t('table.responsible')}: </span>
                {item.currentResponsible?.name ?? (
                  <span className="text-muted-foreground">{t('table.noResponsible')}</span>
                )}
              </td>
              <td className="px-3 py-2 align-top max-md:p-0">
                <div className="flex flex-wrap items-center gap-1">
                  <DueDateBadge deadline={item.deadline} overdueSince={item.overdueSince} />
                  {item.isOverdue ? <OverdueBadge /> : null}
                </div>
              </td>
              {queue ? (
                <td className="px-3 py-2 align-top max-md:p-0">
                  {item.canClaim ? <QuickClaimButton item={item} /> : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Selo "Em atraso" (FA-03): sempre ícone + texto, nunca só cor. */
function OverdueBadge() {
  const t = useTranslations('taskInbox.table');
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-destructive-soft px-2 py-0.5 text-xs font-medium text-destructive">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        <path d="M8 1 15 14H1L8 1Zm-.75 5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z" />
      </svg>
      {t('overdue')}
    </span>
  );
}

/** O que o "Assumir" muda além da caixa: lista de processos e painel inicial. */
const AFTER_CLAIM_KEYS = ['tasks', 'processes', 'dashboard'] as const;

/**
 * "Assumir" (RN-INBOX-11): o PRC-21 da US-049 com `If-Match` (a versão da linha) e
 * `Idempotency-Key`; em sucesso a linha sai da fila e entra em "Comigo" (lista e contadores
 * recarregados); FA-04 avisa e recarrega a linha.
 */
function QuickClaimButton({ item }: { readonly item: TaskInboxItemDto }) {
  const t = useTranslations('taskInbox.claim');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [claiming, setClaiming] = useState(false);
  const refresh = () => {
    for (const key of AFTER_CLAIM_KEYS) {
      void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
    }
  };
  const claim = async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      await claimProcess(item.processId, item.version, crypto.randomUUID());
      toast({ title: t('claimed'), tone: 'success' });
    } catch (error) {
      const problem = describeQuickClaimError(error);
      toast({
        title:
          problem.kind === 'unexpected'
            ? t('errors.unexpected', { correlationId: problem.correlationId })
            : t(`errors.${problem.kind}`),
        tone: 'error',
      });
    } finally {
      setClaiming(false);
      refresh();
    }
  };
  return (
    <Button
      size="sm"
      disabled={claiming}
      aria-label={t('actionLabel', { code: item.code ?? item.title })}
      onClick={() => void claim()}
    >
      {claiming ? t('claiming') : t('action')}
    </Button>
  );
}
