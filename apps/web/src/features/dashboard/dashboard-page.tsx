'use client';

import { renderTimelineEntry } from '@contrataflow/types';
import {
  Alert,
  BarList,
  Button,
  Card,
  ColumnChart,
  Donut,
  EmptyState,
  KpiTile,
  Skeleton,
  StatusChip,
  buttonClassName,
  cx,
} from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type {
  DashboardFilters,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DashboardWidgetOf,
  TaskInboxItemDto,
} from '@contrataflow/validation';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';
import { AppPageHeader } from '@/components/shell/page-header';
import { formatMoney } from '@/lib/i18n/format';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import {
  STATUS_CHART_TONE,
  VIEW_CHIP_TONE,
  departmentOptions,
  describeDashboardError,
  firstName,
  formatDuration,
  greetingPeriod,
  isWidgetEmpty,
  monthLabel,
  parseDashboardFilters,
  pendingDeadline,
  pendingDeadlineTone,
  secretariatOptions,
  seriesItemHref,
  summaryHrefs,
  toDashboardSearch,
} from './dashboard-model';
import {
  usePendingPreview,
  useDashboardSummary,
  useDashboardUnits,
  useDashboardWidget,
} from './dashboard.api';

/**
 * SCR-003 — Painel (US-076): saudação com filtros e "Novo processo", o resumo (DSH-01) em KPIs e
 * um cartão por indicador (DSH-02), cada um com carregamento, vazio e erro próprios; filtros de
 * secretaria/unidade na URL e polling de 60 s. Acesso por `DASHBOARD_VIEW`; a API decide cada
 * requisição. Repaginado no prd-4 (mockup `Painel.dc.html`) sem alterar o contrato.
 */
export function DashboardPage() {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const { allowed, status } = usePermission('DASHBOARD_VIEW');
  const canCreate = usePermission('PROCESS_CREATE').allowed;
  const { user, activeTenant } = useShellSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => parseDashboardFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  // Um instante só por montagem: a saudação e a data não mudam a cada polling.
  const [now] = useState(() => new Date());

  const navigate = useCallback(
    (next: DashboardFilters) => {
      const search = toDashboardSearch(next);
      router.replace(search === '' ? pathname : `${pathname}?${search}`, { scroll: false });
    },
    [router, pathname],
  );
  const resetFilters = useCallback(() => {
    navigate({});
  }, [navigate]);

  const title = t('greeting', {
    period: greetingPeriod(now, activeTenant.timezone),
    name: firstName(user.displayName),
  });
  const description = t('subtitle', {
    date: format.dateTime(now, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: activeTenant.timezone,
    }),
  });

  return (
    <section className="flex min-w-0 flex-col gap-6">
      <AppPageHeader
        title={title}
        description={description}
        actions={
          <>
            {allowed ? <DepartmentFilterBar filters={filters} onChange={navigate} /> : null}
            {canCreate ? (
              <Link href="/processos/novo" className={cx(buttonClassName({}), 'gap-2')}>
                <Icon name="plus" />
                {t('newProcess')}
              </Link>
            ) : null}
          </>
        }
      />

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
        <>
          <DashboardSummaryCards filters={filters} onInvalidFilter={resetFilters} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <PendingItemsCard filters={filters} />
            <StatusCard filters={filters} canCreate={canCreate} />
            <StageCard filters={filters} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DeadlineCard widgetKey="OVERDUE" filters={filters} />
            <DeadlineCard widgetKey="DUE_SOON" filters={filters} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AverageDurationCard filters={filters} />
            <OpenedByMonthCard filters={filters} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ValueBySecretariatCard filters={filters} />
            <RecentActivityFeed filters={filters} />
          </div>
        </>
      ) : null}
    </section>
  );
}

/** `DepartmentFilterBar`: secretaria e unidade (subárvore), refletidas na URL. */
function DepartmentFilterBar({
  filters,
  onChange,
}: {
  readonly filters: DashboardFilters;
  readonly onChange: (next: DashboardFilters) => void;
}) {
  const t = useTranslations('dashboard.filters');
  const units = useDashboardUnits(true);
  const secretariats = secretariatOptions(units.data ?? []);
  const departments = departmentOptions(units.data ?? [], filters.secretariatId);
  const secretariatId = useId();
  const departmentId = useId();
  const field = 'flex min-w-0 flex-1 flex-col gap-1 sm:flex-none';
  const label = 'text-xs font-semibold text-muted-foreground';
  const select =
    'h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 text-sm text-foreground sm:w-48';
  return (
    <form
      aria-label={t('label')}
      className="flex w-full flex-wrap items-end gap-2.5 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className={field}>
        <label htmlFor={secretariatId} className={label}>
          {t('secretariat')}
        </label>
        <select
          id={secretariatId}
          className={select}
          value={filters.secretariatId ?? ''}
          aria-busy={units.isPending}
          onChange={(event) => {
            const value = event.target.value;
            // A unidade só vale dentro da secretaria escolhida (V-03).
            onChange(value === '' ? {} : { secretariatId: value });
          }}
        >
          <option value="">{t('all')}</option>
          {secretariats.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </div>
      <div className={field}>
        <label htmlFor={departmentId} className={label}>
          {t('department')}
        </label>
        <select
          id={departmentId}
          className={select}
          value={filters.departmentId ?? ''}
          aria-busy={units.isPending}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              ...(filters.secretariatId ? { secretariatId: filters.secretariatId } : {}),
              ...(value === '' ? {} : { departmentId: value }),
            });
          }}
        >
          <option value="">{t('all')}</option>
          {departments.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </div>
      {filters.secretariatId || filters.departmentId ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onChange({});
          }}
        >
          {t('clear')}
        </Button>
      ) : null}
    </form>
  );
}

/** Falha de um cartão: mensagem, código copiável (500) e "Tentar novamente" só dele. */
function CardProblem({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('dashboard.errors');
  const problem = describeDashboardError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-2 text-sm">
      <p>
        {problem.kind === 'rateLimited'
          ? t('rateLimited')
          : problem.kind === 'unexpected'
            ? t('unexpected')
            : t('unavailable')}
      </p>
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
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

const SUMMARY_TILES: readonly {
  readonly key: 'pending' | 'overdue' | 'dueSoon' | 'open';
  readonly tone: StatusTone;
  readonly icon: IconName;
}[] = [
  { key: 'pending', tone: 'info', icon: 'inbox' },
  { key: 'overdue', tone: 'danger', icon: 'alert' },
  { key: 'dueSoon', tone: 'warning', icon: 'clock' },
  { key: 'open', tone: 'success', icon: 'folder' },
];

/** `DashboardSummaryCards`: os quatro números de DSH-01, cada um atalho para a lista filtrada. */
function DashboardSummaryCards({
  filters,
  onInvalidFilter,
}: {
  readonly filters: DashboardFilters;
  readonly onInvalidFilter: () => void;
}) {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const { activeTenant } = useShellSession();
  const summary = useDashboardSummary(filters, true);
  // A janela de "próximos do prazo" vem do próprio indicador (mesma consulta do cartão).
  const dueSoon = useDashboardWidget('DUE_SOON', filters, true).data?.data as
    DashboardWidgetOf<'DUE_SOON'> | undefined;
  const problem = summary.error ? describeDashboardError(summary.error) : null;
  // Referência inválida: o filtro volta para "Todas" (Casos de erro).
  useEffect(() => {
    if (problem?.kind === 'invalidReference') onInvalidFilter();
  }, [problem?.kind, onInvalidFilter]);

  const hrefs = summaryHrefs(filters);
  const data = summary.data?.data;
  const values = {
    pending: data?.pendingCount,
    overdue: data?.overdueCount,
    dueSoon: data?.dueSoonCount,
    open: data?.openCount,
  };
  const hint = (key: (typeof SUMMARY_TILES)[number]['key']) =>
    key === 'dueSoon' && dueSoon
      ? t('summary.dueSoonHintDays', { days: dueSoon.warnBeforeBusinessDays })
      : t(`summary.${key}Hint`);

  return (
    <section aria-label={t('summary.label')} className="flex flex-col gap-2">
      {problem?.kind === 'invalidReference' ? (
        <Alert tone="warning" title={t('filters.invalidReference')} />
      ) : null}
      {problem?.kind === 'notInSecretariat' ? (
        <Alert tone="warning" title={t('filters.notInSecretariat')} />
      ) : null}
      {summary.error &&
      problem?.kind !== 'invalidReference' &&
      problem?.kind !== 'notInSecretariat' ? (
        <CardProblem error={summary.error} onRetry={() => void summary.refetch()} />
      ) : null}
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SUMMARY_TILES.map((tile) => {
          const value = values[tile.key];
          return (
            <li key={tile.key} className="min-w-0">
              {value === undefined && summary.isPending ? (
                <div className="rounded-card border border-border bg-surface p-5">
                  <Skeleton className="h-[6.5rem] w-full" />
                </div>
              ) : (
                <KpiTile
                  className="h-full"
                  label={t(`summary.${tile.key}`)}
                  value={value === undefined ? '—' : format.number(value)}
                  context={hint(tile.key)}
                  icon={<Icon name={tile.icon} />}
                  tone={tile.tone}
                  emphasizeValue={tile.key === 'overdue' && (value ?? 0) > 0}
                  href={value === undefined ? undefined : hrefs[tile.key]}
                  linkComponent={Link}
                />
              )}
            </li>
          );
        })}
      </ul>
      {/* Atualização por polling anunciada sem roubar o foco. */}
      <p aria-live="polite" className="sr-only">
        {data
          ? t('summary.updated', {
              time: format.dateTime(new Date(data.generatedAt), {
                timeStyle: 'short',
                timeZone: activeTenant.timezone,
              }),
            })
          : ''}
      </p>
    </section>
  );
}

interface SeriesRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly href: string | null;
  readonly note?: ReactNode;
}

/** Linhas de um indicador (nomes traduzidos, valores formatados e atalhos). */
function useSeriesRows(widget: DashboardWidgetDto | undefined, filters: DashboardFilters) {
  const t = useTranslations('dashboard.card');
  const tStatus = useTranslations('processes.statuses');
  const tInbox = useTranslations('taskInbox.tabs');
  const format = useFormatter();
  if (widget === undefined || widget.widgetKey === 'RECENT_ACTIVITY') return [];
  const href = (key: string) => seriesItemHref(widget.widgetKey, key, filters);
  switch (widget.widgetKey) {
    case 'PENDING_ITEMS':
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: tInbox(item.key),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
    case 'BY_STATUS':
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: tStatus(item.key),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
    case 'OPENED_BY_MONTH':
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: monthLabel(item.key),
        value: item.value,
        display: format.number(item.value),
        href: null,
      }));
    case 'AVG_STAGE_DURATION':
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: item.value,
        display: t('duration', formatDuration(item.value)),
        href: null,
        note: t('samplesCount', { count: item.sampleSize }),
      }));
    case 'VALUE_BY_SECRETARIAT':
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: Number(item.value),
        display: formatMoney(item.value),
        href: href(item.key),
        note: item.confidentialExcluded ? <ConfidentialNote /> : undefined,
      }));
    default:
      return widget.series.map<SeriesRow>((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
  }
}

/** POL-09: o grupo tem processo de orçamento sigiloso fora da soma. */
function ConfidentialNote() {
  const t = useTranslations('dashboard.card');
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon name="shield" className="size-3.5" />
      <span title={t('confidentialExcludedHint')}>{t('confidentialExcluded')}</span>
    </span>
  );
}

/** A mesma série em tabela (RN-DASH-12): a alternativa acessível de todo gráfico. */
function SeriesTable({
  rows,
  caption,
  itemLabel,
  valueLabel,
  valueClassName,
}: {
  readonly rows: readonly SeriesRow[];
  readonly caption: string;
  readonly itemLabel: string;
  readonly valueLabel: string;
  readonly valueClassName?: string | undefined;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="py-2 pr-3">
              {itemLabel}
            </th>
            <th scope="col" className="py-2 text-right">
              {valueLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2.5 pr-3 text-left font-semibold text-brand-ink">
                {row.href ? (
                  <Link href={row.href} className="hover:text-primary-hover hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  row.label
                )}
                {row.note ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {row.note}
                  </span>
                ) : null}
              </th>
              <td className={cx('py-2.5 text-right font-bold tabular-nums', valueClassName)}>
                {row.display}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Botão do cabeçalho que alterna gráfico ↔ tabela. */
function TableToggle({
  showTable,
  onToggle,
}: {
  readonly showTable: boolean;
  readonly onToggle: () => void;
}) {
  const t = useTranslations('dashboard.card');
  return (
    <Button type="button" variant="ghost" size="sm" aria-pressed={showTable} onClick={onToggle}>
      {showTable ? t('showChart') : t('showTable')}
    </Button>
  );
}

/** Link discreto do cabeçalho de um cartão ("Ver todas", "Ver processos"). */
function HeaderLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-9 items-center rounded-control px-1 font-semibold text-primary-soft-foreground hover:text-primary-hover hover:underline"
    >
      {children}
    </Link>
  );
}

type GridWidgetKey = Exclude<DashboardWidgetKey, 'RECENT_ACTIVITY'>;

/**
 * Moldura de um indicador: busca própria (DSH-02), skeleton, erro com "Tentar novamente", estado
 * vazio contextual com ação e o conteúdo; some quando o indicador não existe (404).
 */
function WidgetCard<K extends GridWidgetKey>({
  widgetKey,
  filters,
  action,
  description,
  emptyAction,
  children,
}: {
  readonly widgetKey: K;
  readonly filters: DashboardFilters;
  readonly action?: (widget: DashboardWidgetOf<K> | undefined) => ReactNode;
  readonly description?: (widget: DashboardWidgetOf<K>) => ReactNode;
  readonly emptyAction?: ReactNode;
  readonly children: (widget: DashboardWidgetOf<K>) => ReactNode;
}) {
  const t = useTranslations('dashboard');
  const key: GridWidgetKey = widgetKey;
  const query = useDashboardWidget(key, filters, true);
  const id = useId();
  const dto = query.data?.data;
  const widget = dto as DashboardWidgetOf<K> | undefined;
  const problem = query.error ? describeDashboardError(query.error) : null;
  if (problem?.kind === 'hidden') return null;
  // Filtro inválido: o resumo explica e devolve os filtros para "Todas".
  const filterProblem =
    problem?.kind === 'invalidReference' || problem?.kind === 'notInSecretariat';
  const empty = dto !== undefined && isWidgetEmpty(dto);
  return (
    <Card
      id={id}
      title={t(`widgets.${key}.title`)}
      description={widget && !empty && description ? description(widget) : undefined}
      action={action?.(empty ? undefined : widget)}
      aria-busy={query.isFetching}
      className="min-w-0"
    >
      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('card.loading')}</span>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {query.error && !filterProblem ? (
        <CardProblem error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {widget ? (
        empty ? (
          <EmptyState
            className="flex-1 justify-center"
            title={t(`widgets.${key}.empty`, {
              days: dto.widgetKey === 'DUE_SOON' ? dto.warnBeforeBusinessDays : 0,
            })}
            action={emptyAction}
          />
        ) : (
          children(widget)
        )
      ) : null}
    </Card>
  );
}

/** "Minhas pendências": contagens por visão (TSK-02) e os primeiros itens de "Comigo" (TSK-01). */
function PendingItemsCard({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard');
  const tInbox = useTranslations('taskInbox.tabs');
  const format = useFormatter();
  const inbox = usePermission('INBOX_VIEW').allowed;
  const preview = usePendingPreview(inbox);
  return (
    <WidgetCard
      widgetKey="PENDING_ITEMS"
      filters={filters}
      action={() => <HeaderLink href="/tarefas">{t('pending.seeAll')}</HeaderLink>}
      emptyAction={
        <Link href="/tarefas" className={buttonClassName({ variant: 'secondary', size: 'sm' })}>
          {t('pending.openInbox')}
        </Link>
      }
    >
      {(widget) => (
        <div className="flex flex-col gap-3">
          <ul aria-label={t('pending.byView')} className="flex flex-wrap gap-2">
            {widget.series.map((item) => (
              <li key={item.key}>
                <Link href="/tarefas" className="rounded-full hover:underline">
                  <StatusChip tone={VIEW_CHIP_TONE[item.key]}>
                    {t('pending.viewCount', {
                      label: tInbox(item.key),
                      count: format.number(item.value),
                    })}
                  </StatusChip>
                </Link>
              </li>
            ))}
          </ul>
          {preview.data && preview.data.length > 0 ? (
            <ul aria-label={t('pending.nextItems')} className="flex flex-col">
              {preview.data.map((item) => (
                <PendingRow key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </WidgetCard>
  );
}

const TEXT_TONE: Readonly<Record<StatusTone, string>> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  approval: 'text-approval',
  neutral: 'text-muted-foreground',
};

/** Uma pendência: processo, código e etapa, e o prazo em texto colorido. */
function PendingRow({ item }: { readonly item: TaskInboxItemDto }) {
  const t = useTranslations('dashboard.pending');
  const tDeadline = useTranslations('processList.deadline');
  const deadline = pendingDeadline(item.deadline, item.overdueSince);
  const label =
    deadline.kind === 'overdue'
      ? tDeadline(deadline.calendar ? 'overdueCalendar' : 'overdue', { count: deadline.count })
      : deadline.kind === 'dueIn'
        ? tDeadline(deadline.calendar ? 'dueInCalendar' : 'dueIn', { count: deadline.count })
        : tDeadline(deadline.kind);
  const context = [item.code ?? t('noCode'), item.currentStage?.name]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return (
    <li className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0">
      <Link
        href={`/processos/${item.processId}`}
        className="text-sm font-semibold break-words text-brand-ink hover:text-primary-hover hover:underline"
      >
        {item.title}
      </Link>
      <span className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[0.8125rem] text-muted-foreground">
        <span className="min-w-0 break-words">{context}</span>
        <span
          className={cx(
            'font-semibold whitespace-nowrap',
            TEXT_TONE[pendingDeadlineTone(deadline)],
          )}
        >
          {label}
        </span>
      </span>
    </li>
  );
}

/** "Processos por situação": donut com legenda (cada situação leva à lista filtrada). */
function StatusCard({
  filters,
  canCreate,
}: {
  readonly filters: DashboardFilters;
  readonly canCreate: boolean;
}) {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const [showTable, setShowTable] = useState(false);
  const widget = useDashboardWidget('BY_STATUS', filters, true).data?.data;
  const rows = useSeriesRows(widget, filters);
  const title = t('widgets.BY_STATUS.title');
  return (
    <WidgetCard
      widgetKey="BY_STATUS"
      filters={filters}
      action={(loaded) =>
        loaded ? (
          <TableToggle
            showTable={showTable}
            onToggle={() => {
              setShowTable((current) => !current);
            }}
          />
        ) : null
      }
      emptyAction={
        canCreate ? (
          <Link href="/processos/novo" className={buttonClassName({ size: 'sm' })}>
            {t('empty.createProcess')}
          </Link>
        ) : null
      }
    >
      {(loaded) =>
        showTable ? (
          <SeriesTable
            rows={rows}
            caption={t('card.tableCaption', { title })}
            itemLabel={t('card.status')}
            valueLabel={t('card.processes')}
          />
        ) : (
          <Donut
            label={t('card.statusChart', {
              count: loaded.total,
              items: rows.map((row) => `${row.display} ${row.label}`).join(', '),
            })}
            centerValue={format.number(loaded.total)}
            centerLabel={t('card.centerLabel', { count: loaded.total })}
            formatValue={(value) => format.number(value)}
            segments={rows.map((row) => ({
              id: row.key,
              value: row.value,
              tone: STATUS_CHART_TONE[row.key as keyof typeof STATUS_CHART_TONE],
              label: row.href ? (
                <Link href={row.href} className="hover:text-primary-hover hover:underline">
                  {row.label}
                </Link>
              ) : (
                row.label
              ),
            }))}
          />
        )
      }
    </WidgetCard>
  );
}

/** Barras horizontais com alternância para tabela (etapas, meses, valor por secretaria). */
function BarWidgetCard({
  widgetKey,
  filters,
  formatValue,
  valueLabel,
}: {
  readonly widgetKey: 'BY_STAGE' | 'OPENED_BY_MONTH' | 'VALUE_BY_SECRETARIAT';
  readonly filters: DashboardFilters;
  readonly formatValue?: (value: number) => string;
  readonly valueLabel: string;
}) {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  const [showTable, setShowTable] = useState(false);
  const widget = useDashboardWidget(widgetKey, filters, true).data?.data;
  const rows = useSeriesRows(widget, filters);
  const title = t(`widgets.${widgetKey}.title`);
  return (
    <WidgetCard
      widgetKey={widgetKey}
      filters={filters}
      description={(loaded) =>
        'total' in loaded ? t('card.total', { count: loaded.total }) : undefined
      }
      action={(loaded) =>
        loaded ? (
          <TableToggle
            showTable={showTable}
            onToggle={() => {
              setShowTable((current) => !current);
            }}
          />
        ) : null
      }
    >
      {() =>
        showTable ? (
          <SeriesTable
            rows={rows}
            caption={t('card.tableCaption', { title })}
            itemLabel={t('card.item')}
            valueLabel={valueLabel}
          />
        ) : (
          <BarList
            linkComponent={Link}
            formatValue={formatValue ?? ((value) => format.number(value))}
            items={rows.map((row) => ({
              id: row.key,
              value: row.value,
              href: row.href ?? undefined,
              label: row.note ? (
                <>
                  {row.label} {row.note}
                </>
              ) : (
                row.label
              ),
            }))}
          />
        )
      }
    </WidgetCard>
  );
}

function StageCard({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard.card');
  return <BarWidgetCard widgetKey="BY_STAGE" filters={filters} valueLabel={t('processes')} />;
}

function OpenedByMonthCard({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard.card');
  return (
    <BarWidgetCard widgetKey="OPENED_BY_MONTH" filters={filters} valueLabel={t('processes')} />
  );
}

function ValueBySecretariatCard({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard.card');
  return (
    <BarWidgetCard
      widgetKey="VALUE_BY_SECRETARIAT"
      filters={filters}
      valueLabel={t('estimatedValue')}
      formatValue={(value) => formatMoney(value.toFixed(2))}
    />
  );
}

/** Atrasados e próximos do prazo por secretaria: tabela com atalho para a lista filtrada. */
function DeadlineCard({
  widgetKey,
  filters,
}: {
  readonly widgetKey: 'OVERDUE' | 'DUE_SOON';
  readonly filters: DashboardFilters;
}) {
  const t = useTranslations('dashboard');
  const widget = useDashboardWidget(widgetKey, filters, true).data?.data;
  const rows = useSeriesRows(widget, filters);
  const hrefs = summaryHrefs(filters);
  return (
    <WidgetCard
      widgetKey={widgetKey}
      filters={filters}
      description={(loaded) => t('card.total', { count: loaded.total })}
      action={() => (
        <HeaderLink href={widgetKey === 'OVERDUE' ? hrefs.overdue : hrefs.dueSoon}>
          {t('card.seeProcesses')}
        </HeaderLink>
      )}
    >
      {() => (
        <SeriesTable
          rows={rows}
          caption={t(`widgets.${widgetKey}.title`)}
          itemLabel={t('card.secretariat')}
          valueLabel={t('card.processes')}
          valueClassName={widgetKey === 'OVERDUE' ? 'text-destructive' : 'text-warning'}
        />
      )}
    </WidgetCard>
  );
}

/** Tempo médio por etapa: colunas com o valor em texto; a tabela traz também as passagens. */
function AverageDurationCard({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard');
  const [showTable, setShowTable] = useState(false);
  const widget = useDashboardWidget('AVG_STAGE_DURATION', filters, true).data?.data;
  const rows = useSeriesRows(widget, filters);
  const title = t('widgets.AVG_STAGE_DURATION.title');
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <WidgetCard
      widgetKey="AVG_STAGE_DURATION"
      filters={filters}
      description={() => t('card.averageHint')}
      action={(loaded) =>
        loaded ? (
          <TableToggle
            showTable={showTable}
            onToggle={() => {
              setShowTable((current) => !current);
            }}
          />
        ) : null
      }
    >
      {() =>
        showTable ? (
          <SeriesTable
            rows={rows}
            caption={t('card.tableCaption', { title })}
            itemLabel={t('card.stage')}
            valueLabel={t('card.average')}
          />
        ) : (
          <ColumnChart
            label={t('card.averageChart', {
              items: rows.map((row) => `${row.label} ${row.display}`).join('; '),
            })}
            formatValue={(value) => t('card.duration', formatDuration(value))}
            items={rows.map((row) => ({
              id: row.key,
              value: row.value,
              // A etapa mais demorada em destaque (navy), as demais no azul da ação.
              tone: row.value === max ? 'navy' : 'info',
              label: <span title={row.label}>{row.label}</span>,
            }))}
          />
        )
      }
    </WidgetCard>
  );
}

/** `RecentActivityFeed`: as últimas entradas da timeline dos processos visíveis. */
function RecentActivityFeed({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard');
  const { activeTenant } = useShellSession();
  const query = useDashboardWidget('RECENT_ACTIVITY', filters, true);
  const widget = query.data?.data as DashboardWidgetOf<'RECENT_ACTIVITY'> | undefined;
  const id = useId();
  const time = (iso: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: activeTenant.timezone,
    }).format(new Date(iso));
  return (
    <Card
      id={id}
      title={t('widgets.RECENT_ACTIVITY.title')}
      aria-busy={query.isFetching}
      className="min-w-0"
    >
      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('card.loading')}</span>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {query.error && describeDashboardError(query.error).kind !== 'invalidReference' ? (
        <CardProblem error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {widget?.items.length === 0 ? (
        <EmptyState title={t('widgets.RECENT_ACTIVITY.empty')} />
      ) : null}
      {widget && widget.items.length > 0 ? (
        <ul className="flex flex-col">
          {widget.items.map((entry) => {
            const { message, detail } = renderTimelineEntry(entry);
            return (
              <li
                key={entry.id}
                className="flex min-w-0 flex-col gap-0.5 border-t border-border py-3 first:border-t-0 first:pt-0"
              >
                <Link
                  href={`/processos/${entry.process.id}`}
                  className="text-sm font-semibold text-brand-ink hover:text-primary-hover hover:underline"
                >
                  {entry.process.code
                    ? t('activity.process', { code: entry.process.code })
                    : t('activity.noCode')}
                </Link>
                <p className="text-sm break-words">{message}</p>
                {detail ? (
                  <p className="text-sm break-words text-muted-foreground">“{detail}”</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  <time dateTime={entry.occurredAt}>{time(entry.occurredAt)}</time>
                  {` · ${entry.actorName ?? t('activity.system')}`}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
