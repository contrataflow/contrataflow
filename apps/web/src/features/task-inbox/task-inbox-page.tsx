'use client';

import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Clock,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Field,
  FilterToolbar,
  Hourglass,
  ListPage,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
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
  buttonClassName,
  toast,
} from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
import type { TaskInboxItemDto, TaskInboxSort, TaskInboxView } from '@contrataflow/validation';
import { formatTaskInboxSort } from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { AppPageHeader } from '@/components/shell/page-header';
import { claimProcess } from '@/features/process-claim/process-claim.api';
import { ConfidentialBadge } from '@/features/process-list/process-list-badges';
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
  EMPTY_REFINE,
  NO_RESPONSIBLE,
  activeRefineFilters,
  counterOf,
  describeLoadError,
  describeQuickClaimError,
  inboxDeadlineOf,
  isRefined,
  parseSortOption,
  refineItems,
  refineOptionsOf,
  sortForView,
  sortOptions,
  visibleTabs,
} from './task-inbox-model';
import type { InboxRefine, InboxRefineFilter, RefineOption } from './task-inbox-model';
import { useTaskInbox, useTaskInboxCounters } from './task-inbox.api';

/** Seleção múltipla da fila da unidade (US-058): só existe com alguma ação em lote disponível. */
interface BulkSelectionControl {
  readonly selection: BulkSelection;
  readonly onChange: (selection: BulkSelection) => void;
}

/** "Todas"/"Todos" no `Select` (o Radix não aceita valor vazio). */
const ANY = '__any__';

const PANEL_ID = 'caixa-de-tarefas-visao';

/**
 * SCR-013 — Caixa de tarefas (US-056) no modelo `ListPage` (prd-5): visões em abas com contadores
 * (TSK-02, "Atrasados" em tom de erro), busca e filtros fechados num popover, ordenação (RN-INBOX-10),
 * tabela de até 6 colunas com um só chip de prazo e o menu ⋯ por linha ("Assumir" — PRC-21 — na
 * fila da unidade), paginação no rodapé e polling de 60 s (RN-INBOX-13). Acesso por `INBOX_VIEW`;
 * a API decide cada requisição. Na fila da unidade, a seleção múltipla abre a barra flutuante das
 * ações em lote (US-058 · TSK-03/TSK-04): "Assumir selecionados" com `PROCESS_CLAIM`; "Atribuir
 * selecionados" com `PROCESS_ASSIGN` ou chefia de unidade.
 */
export function TaskInboxPage() {
  const t = useTranslations('taskInbox');
  const { allowed, status } = usePermission('INBOX_VIEW');
  const [view, setView] = useState<TaskInboxView>('MINE');
  const [sort, setSort] = useState<TaskInboxSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [refine, setRefine] = useState<InboxRefine>(EMPTY_REFINE);
  const [announcement, setAnnouncement] = useState('');
  const counters = useTaskInboxCounters(allowed);
  const list = useTaskInbox(view, sort, page, allowed);
  const quickClaim = useQuickClaim();
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

  if (!allowed) {
    return (
      <section className="flex min-w-0 flex-col gap-5">
        <AppPageHeader title={t('title')} description={t('description')} />
        {status === 'pending' ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t('loadingPermission')}</span>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        )}
      </section>
    );
  }

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

  const data = list.data;
  const items = data?.items ?? [];
  const shown = refineItems(items, refine);
  const refined = isRefined(refine);
  const retry = () => {
    void list.refetch();
    void counters.refetch();
  };

  return (
    <ListPage
      // Espaço para a barra flutuante do lote não cobrir a última linha.
      className={selection.size > 0 && bulk !== null ? 'pb-24' : undefined}
      header={<AppPageHeader title={t('title')} description={t('description')} />}
      tabs={
        <ViewTabs
          label={t('tabs.label')}
          value={view}
          panelId={PANEL_ID}
          onValueChange={(id) => {
            select(id as TaskInboxView);
          }}
          tabs={visibleTabs(counters.data).map((tab) => {
            const count = counterOf(counters.data, tab);
            const label = t(`tabs.${tab}`);
            return {
              id: tab,
              label,
              count,
              tone: tab === 'OVERDUE' ? ('danger' as const) : undefined,
              accessibleLabel:
                count === undefined ? undefined : t('tabs.countLabel', { label, count }),
            };
          })}
        />
      }
      toolbar={
        <InboxToolbar
          view={view}
          sort={sort}
          refine={refine}
          items={items}
          onRefine={setRefine}
          onSort={(next) => {
            setSort(next);
            setPage(1);
          }}
        />
      }
      notices={
        <>
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
          {refined && data !== undefined && data.meta.totalPages > 1 ? (
            <p className="text-sm text-muted-foreground">{t('filters.pageOnly')}</p>
          ) : null}
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
        </>
      }
      error={
        list.isError ? (
          <LoadError error={list.error} onRetry={retry} compact={data !== undefined} />
        ) : null
      }
      loading={list.isPending && !list.isError}
      loadingLabel={t('loading')}
    >
      <div
        role="tabpanel"
        id={PANEL_ID}
        aria-label={t(`tabs.${view}`)}
        className="flex min-w-0 flex-col gap-3"
      >
        {list.isFetching && data ? (
          <div
            role="progressbar"
            aria-label={t('refreshing')}
            className="h-1 w-full animate-pulse rounded bg-primary/40"
          />
        ) : null}
        {data === undefined ? null : shown.length === 0 ? (
          <InboxEmpty
            view={view}
            refined={refined}
            onClear={() => {
              setRefine(EMPTY_REFINE);
            }}
          />
        ) : (
          <TableContainer
            label={t('table.caption', { view: t(`tabs.${view}`) })}
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
                <Link
                  href="/processos"
                  className="font-semibold text-primary-soft-foreground underline-offset-2 hover:underline"
                >
                  {t('footer.allProcesses')}
                </Link>
              </TableFooter>
            }
          >
            <InboxTable view={view} items={shown} bulk={bulk} quickClaim={quickClaim} />
          </TableContainer>
        )}
      </div>
    </ListPage>
  );
}

/** Busca inline, popover com unidade, etapa e responsável, chips do que está ativo e ordenação. */
function InboxToolbar({
  view,
  sort,
  refine,
  items,
  onRefine,
  onSort,
}: {
  readonly view: TaskInboxView;
  readonly sort: TaskInboxSort;
  readonly refine: InboxRefine;
  readonly items: readonly TaskInboxItemDto[];
  readonly onRefine: (refine: InboxRefine) => void;
  readonly onSort: (sort: TaskInboxSort) => void;
}) {
  const t = useTranslations('taskInbox');
  const tSort = useTranslations('taskInbox.sort');
  const options = refineOptionsOf(items);
  const responsibles: RefineOption[] = options.hasUnassigned
    ? [...options.responsibles, { value: NO_RESPONSIBLE, label: t('filters.noResponsible') }]
    : options.responsibles;
  const labelOf = (key: InboxRefineFilter) =>
    key === 'departmentId'
      ? t('filters.department')
      : key === 'stageKey'
        ? t('filters.stage')
        : t('filters.responsible');
  const valueOf = (key: InboxRefineFilter, value: string) => {
    const pool =
      key === 'departmentId'
        ? options.departments
        : key === 'stageKey'
          ? options.stages
          : responsibles;
    return pool.find((option) => option.value === value)?.label ?? value;
  };
  const active = activeRefineFilters(refine);
  const chips: FilterToolbarChip[] = active.map((key) => {
    const label = labelOf(key);
    const value = valueOf(key, refine[key] ?? '');
    return {
      id: key,
      label: t('filters.chip', { label, value }),
      removeLabel: t('filters.remove', { label: `${label}: ${value}` }),
      onRemove: () => {
        onRefine({ ...refine, [key]: null });
      },
    };
  });

  return (
    <FilterToolbar
      search={{
        value: refine.q,
        onChange: (q) => {
          onRefine({ ...refine, q });
        },
        label: t('search.label'),
        placeholder: t('search.placeholder'),
      }}
      filters={
        <>
          <RefineSelect
            label={t('filters.department')}
            anyLabel={t('filters.any')}
            options={options.departments}
            value={refine.departmentId}
            onChange={(departmentId) => {
              onRefine({ ...refine, departmentId });
            }}
          />
          <RefineSelect
            label={t('filters.stage')}
            anyLabel={t('filters.any')}
            options={options.stages}
            value={refine.stageKey}
            onChange={(stageKey) => {
              onRefine({ ...refine, stageKey });
            }}
          />
          <RefineSelect
            label={t('filters.responsible')}
            anyLabel={t('filters.anyResponsible')}
            options={responsibles}
            value={refine.responsibleId}
            onChange={(responsibleId) => {
              onRefine({ ...refine, responsibleId });
            }}
          />
        </>
      }
      activeCount={active.length}
      chips={chips}
      onClearAll={() => {
        onRefine({ ...refine, departmentId: null, stageKey: null, responsibleId: null });
      }}
      sort={{
        value: formatTaskInboxSort(sort),
        onValueChange: (value) => {
          onSort(parseSortOption(value, view));
        },
        options: sortOptions(view).map((option) => ({
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

function RefineSelect({
  label,
  anyLabel,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly anyLabel: string;
  readonly options: readonly RefineOption[];
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value ?? ANY}
        onValueChange={(next) => {
          onChange(next === ANY ? null : next);
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Estado vazio por visão (ícone, uma frase e a ação seguinte) ou do refino sem resultado. */
function InboxEmpty({
  view,
  refined,
  onClear,
}: {
  readonly view: TaskInboxView;
  readonly refined: boolean;
  readonly onClear: () => void;
}) {
  const t = useTranslations('taskInbox');
  if (refined) {
    return (
      <EmptyState
        title={t('filters.noMatch')}
        action={
          <Button variant="secondary" onClick={onClear}>
            {t('filters.clear')}
          </Button>
        }
      />
    );
  }
  const approvals = view === 'PENDING_APPROVALS';
  return (
    <EmptyState
      title={t(`empty.${view}`)}
      action={
        <Link
          href={approvals ? '/aprovacoes' : '/processos'}
          className={buttonClassName({ variant: 'secondary' })}
        >
          {approvals ? t('empty.approvals') : t('empty.allProcesses')}
        </Link>
      }
    />
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

const CELL = 'max-md:p-0';

function InboxTable({
  view,
  items,
  bulk,
  quickClaim,
}: {
  readonly view: TaskInboxView;
  readonly items: readonly TaskInboxItemDto[];
  readonly bulk: BulkSelectionControl | null;
  readonly quickClaim: QuickClaim;
}) {
  const t = useTranslations('taskInbox');
  const format = useFormatter();
  const approvals = view === 'PENDING_APPROVALS';
  const selectable = bulk === null ? [] : items.filter(isSelectable).map(selectedItemOf);
  const selectedOnPage =
    bulk === null ? 0 : selectable.filter((item) => bulk.selection.has(item.processId)).length;
  const pageSelected = selectable.length > 0 && selectedOnPage === selectable.length;
  return (
    <Table className="md:min-w-[52rem]">
      <caption className="sr-only">{t('table.caption', { view: t(`tabs.${view}`) })}</caption>
      <TableHead className="max-md:sr-only">
        <Tr>
          {bulk === null ? null : (
            <Th className="w-12">
              <Checkbox
                aria-label={t('bulk.selectPage')}
                checked={pageSelected ? true : selectedOnPage > 0 ? 'indeterminate' : false}
                disabled={selectable.length === 0}
                onCheckedChange={() => {
                  bulk.onChange(togglePage(bulk.selection, selectable));
                }}
              />
            </Th>
          )}
          <Th>{t('table.process')}</Th>
          {approvals ? <Th>{t('table.requestedBy')}</Th> : null}
          <Th>{t('table.stage')}</Th>
          <Th>{t('table.department')}</Th>
          {approvals ? null : <Th>{t('table.responsible')}</Th>}
          <Th>{t('table.deadline')}</Th>
          <Th className="w-14">
            <span className="sr-only">{t('row.actionsColumn')}</span>
          </Th>
        </Tr>
      </TableHead>
      <TableBody>
        {items.map((item) => {
          const code = item.code ?? t('table.noCode');
          return (
            <Tr
              key={item.id}
              className="max-md:relative max-md:flex max-md:flex-col max-md:gap-1.5 max-md:p-4 max-md:pr-14"
            >
              {bulk === null ? null : (
                <Td className={CELL}>
                  {isSelectable(item) ? (
                    <Checkbox
                      aria-label={t('bulk.selectRow', { code: item.code ?? item.title })}
                      checked={bulk.selection.has(item.processId)}
                      disabled={!bulk.selection.has(item.processId) && isFull(bulk.selection)}
                      onCheckedChange={() => {
                        bulk.onChange(toggleSelection(bulk.selection, selectedItemOf(item)));
                      }}
                    />
                  ) : null}
                </Td>
              )}
              <Td className={CELL}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={`/processos/${item.processId}`}
                    className="font-bold break-words text-brand-ink underline-offset-2 hover:text-primary hover:underline"
                  >
                    {item.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {item.approval ? `${code} · ${item.approval.title}` : code}
                  </span>
                  {item.isBudgetConfidential ? (
                    <span className="mt-1">
                      <ConfidentialBadge />
                    </span>
                  ) : null}
                </div>
              </Td>
              {approvals ? (
                <Td className={CELL}>
                  <span className="md:sr-only">{t('table.requestedBy')}: </span>
                  {item.approval ? (
                    <span className="inline-flex flex-col">
                      <span>{item.approval.requestedBy.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {format.dateTime(new Date(item.approval.requestedAt), {
                          dateStyle: 'short',
                        })}
                      </span>
                    </span>
                  ) : null}
                </Td>
              ) : null}
              <Td className={CELL}>
                <span className="md:sr-only">{t('table.stage')}: </span>
                {item.currentStage?.name ?? t('table.noStage')}
              </Td>
              <Td className={`${CELL} max-md:text-muted-foreground`}>
                <span className="md:sr-only">{t('table.department')}: </span>
                {item.currentDepartment.name}
              </Td>
              {approvals ? null : (
                <Td className={CELL}>
                  <span className="md:sr-only">{t('table.responsible')}: </span>
                  {item.currentResponsible ? (
                    <span className="inline-flex items-center gap-2">
                      <Avatar name={item.currentResponsible.name} size="sm" />
                      {item.currentResponsible.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t('table.noResponsible')}</span>
                  )}
                </Td>
              )}
              <Td className={CELL}>
                <DeadlineChip item={item} />
              </Td>
              <Td className="text-right max-md:absolute max-md:top-2 max-md:right-2 max-md:p-0">
                <RowMenu item={item} code={code} quickClaim={quickClaim} />
              </Td>
            </Tr>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Um só chip de prazo (FA-03): sempre ícone + texto, nunca só cor. */
function DeadlineChip({ item }: { readonly item: TaskInboxItemDto }) {
  const t = useTranslations('taskInbox.deadline');
  const deadline = inboxDeadlineOf(item);
  const Icon =
    deadline.tone === 'danger' ? TriangleAlert : deadline.tone === 'warning' ? Hourglass : Clock;
  return (
    <StatusChip tone={deadline.tone} icon={<Icon aria-hidden="true" />}>
      {t(deadline.key, { count: deadline.count })}
    </StatusChip>
  );
}

/** Menu ⋯ da linha: abrir, "Assumir" (quando elegível) e atalhos para as abas do processo. */
function RowMenu({
  item,
  code,
  quickClaim,
}: {
  readonly item: TaskInboxItemDto;
  readonly code: string;
  readonly quickClaim: QuickClaim;
}) {
  const t = useTranslations('taskInbox');
  const href = `/processos/${item.processId}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('row.actions', { code })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={href}>{t('row.open')}</Link>
        </DropdownMenuItem>
        {item.canClaim ? (
          <DropdownMenuItem
            disabled={quickClaim.claimingId === item.processId}
            aria-label={t('claim.actionLabel', { code: item.code ?? item.title })}
            onSelect={() => {
              void quickClaim.claim(item);
            }}
          >
            {quickClaim.claimingId === item.processId ? t('claim.claiming') : t('claim.menu')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`${href}?aba=tramitacao`}>{t('row.movements')}</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`${href}?aba=participantes`}>{t('row.follow')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** O que o "Assumir" muda além da caixa: lista de processos e painel inicial. */
const AFTER_CLAIM_KEYS = ['tasks', 'processes', 'dashboard'] as const;

interface QuickClaim {
  readonly claimingId: string | null;
  readonly claim: (item: TaskInboxItemDto) => Promise<void>;
}

/**
 * "Assumir" (RN-INBOX-11): o PRC-21 da US-049 com `If-Match` (a versão da linha) e
 * `Idempotency-Key`; em sucesso a linha sai da fila e entra em "Comigo" (lista e contadores
 * recarregados); FA-04 avisa e recarrega a linha. Fica fora do menu ⋯, que fecha ao escolher.
 */
function useQuickClaim(): QuickClaim {
  const t = useTranslations('taskInbox.claim');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const claim = async (item: TaskInboxItemDto) => {
    if (claimingId !== null) return;
    setClaimingId(item.processId);
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
      setClaimingId(null);
      for (const key of AFTER_CLAIM_KEYS) {
        void queryClient.invalidateQueries({ queryKey: tenantKey(tenantId, key) });
      }
    }
  };
  return { claimingId, claim };
}
