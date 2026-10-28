'use client';

import { renderTimelineEntry } from '@contrataflow/types';
import { Alert, Button, Skeleton, cx } from '@contrataflow/ui';
import { DASHBOARD_DEFAULT_LAYOUT } from '@contrataflow/validation';
import type {
  DashboardFilters,
  DashboardWidgetDto,
  DashboardWidgetKey,
  DashboardWidgetOf,
} from '@contrataflow/validation';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { Icon } from '@/components/shell/icons';
import { AppPageHeader } from '@/components/shell/page-header';
import { formatMoney } from '@/lib/i18n/format';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import {
  barPercent,
  departmentOptions,
  describeDashboardError,
  formatDuration,
  isWidgetEmpty,
  monthLabel,
  parseDashboardFilters,
  secretariatOptions,
  seriesItemHref,
  summaryHrefs,
  toDashboardSearch,
} from './dashboard-model';
import type { DashboardTone } from './dashboard-model';
import { useDashboardSummary, useDashboardUnits, useDashboardWidget } from './dashboard.api';

/** Cartões da grade (a atividade recente fica em lista própria, abaixo). */
const GRID_WIDGETS = DASHBOARD_DEFAULT_LAYOUT.filter((key) => key !== 'RECENT_ACTIVITY');

/**
 * SCR-003 — Painel (US-076): o resumo (DSH-01) e um cartão por indicador (DSH-02), cada um com
 * carregamento e erro próprios, filtros de secretaria/unidade na URL e polling de 60 s. Acesso por
 * `DASHBOARD_VIEW`; a API decide cada requisição.
 */
export function DashboardPage() {
  const t = useTranslations('dashboard');
  const { allowed, status } = usePermission('DASHBOARD_VIEW');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => parseDashboardFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

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
        <>
          <DepartmentFilterBar filters={filters} onChange={navigate} />
          <DashboardSummaryCards filters={filters} onInvalidFilter={resetFilters} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {GRID_WIDGETS.map((widgetKey) => (
              <DashboardWidgetCard key={widgetKey} widgetKey={widgetKey} filters={filters} />
            ))}
          </div>
          <RecentActivityFeed filters={filters} />
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
  const select =
    'h-10 w-full min-w-0 rounded-control border border-border bg-surface px-3 text-sm sm:w-64';
  return (
    <form
      aria-label={t('label')}
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={secretariatId} className="text-sm font-medium">
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
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={departmentId} className="text-sm font-medium">
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
          variant="secondary"
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
  const problem = summary.error ? describeDashboardError(summary.error) : null;
  // Referência inválida: o filtro volta para "Todas" (Casos de erro).
  useEffect(() => {
    if (problem?.kind === 'invalidReference') onInvalidFilter();
  }, [problem?.kind, onInvalidFilter]);

  const hrefs = summaryHrefs(filters);
  const data = summary.data?.data;
  const cards = [
    { key: 'pending', value: data?.pendingCount, href: hrefs.pending, tone: 'neutral' },
    { key: 'overdue', value: data?.overdueCount, href: hrefs.overdue, tone: 'danger' },
    { key: 'dueSoon', value: data?.dueSoonCount, href: hrefs.dueSoon, tone: 'warning' },
    { key: 'open', value: data?.openCount, href: hrefs.open, tone: 'neutral' },
  ] as const;

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
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <li key={card.key} className="min-w-0 rounded-card border border-border bg-surface p-4">
            {card.value === undefined ? (
              summary.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <p className="text-sm text-muted-foreground">{t(`summary.${card.key}`)}: —</p>
              )
            ) : (
              <Link
                href={card.href}
                className="flex flex-col gap-1 rounded-control focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={t('summary.link', {
                  label: t(`summary.${card.key}`),
                  count: card.value,
                })}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  {card.tone === 'danger' ? <Icon name="alert" /> : null}
                  {card.tone === 'warning' ? <Icon name="clock" /> : null}
                  {t(`summary.${card.key}`)}
                </span>
                <span
                  className={cx(
                    'text-3xl font-semibold tabular-nums',
                    card.tone === 'danger' && card.value > 0 && 'text-destructive',
                    card.tone === 'warning' && card.value > 0 && 'text-warning',
                  )}
                >
                  {format.number(card.value)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`summary.${card.key}Hint`)}
                </span>
              </Link>
            )}
          </li>
        ))}
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

interface BarItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly href: string | null;
  readonly note?: ReactNode;
}

const TONE_BAR: Readonly<Record<DashboardTone, string>> = {
  neutral: 'bg-primary',
  danger: 'bg-destructive',
  warning: 'bg-warning',
  success: 'bg-success',
};

/**
 * Barras horizontais acessíveis (RN-DASH-12): rótulo e valor sempre em texto; nos alertas, padrão
 * listrado além da cor. A mesma série também é oferecida como tabela.
 */
function BarList({
  items,
  tone,
  showTable,
  caption,
}: {
  readonly items: readonly BarItem[];
  readonly tone: DashboardTone;
  readonly showTable: boolean;
  readonly caption: string;
}) {
  const t = useTranslations('dashboard.card');
  const max = Math.max(0, ...items.map((item) => item.value));
  if (showTable) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('item')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key} className="border-t border-border">
                <th scope="row" className="py-1 pr-2 text-left font-normal">
                  {item.label}
                  {item.note}
                </th>
                <td className="py-1 text-right tabular-nums">{item.display}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => {
        const label = (
          <span className="flex min-w-0 justify-between gap-2 text-sm">
            <span className="min-w-0 break-words">{item.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{item.display}</span>
          </span>
        );
        return (
          <li key={item.key} className="flex min-w-0 flex-col gap-1">
            {item.href ? (
              <Link
                href={item.href}
                className="rounded-control hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {label}
              </Link>
            ) : (
              label
            )}
            {item.note}
            <span aria-hidden="true" className="h-2 w-full rounded-full bg-muted">
              <span
                className={cx('block h-2 rounded-full', TONE_BAR[tone])}
                style={{
                  width: `${String(barPercent(item.value, max))}%`,
                  ...(tone === 'danger' || tone === 'warning'
                    ? {
                        backgroundImage:
                          'repeating-linear-gradient(45deg, transparent 0 4px, rgb(255 255 255 / 0.45) 4px 6px)',
                      }
                    : {}),
                }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Itens de barra de um indicador (nomes traduzidos, valores formatados e atalhos). */
function useBarItems(widget: DashboardWidgetDto | undefined, filters: DashboardFilters): BarItem[] {
  const t = useTranslations('dashboard.card');
  const tStatus = useTranslations('processes.statuses');
  const tInbox = useTranslations('taskInbox.tabs');
  const format = useFormatter();
  if (widget === undefined || widget.widgetKey === 'RECENT_ACTIVITY') return [];
  const href = (key: string) => seriesItemHref(widget.widgetKey, key, filters);
  switch (widget.widgetKey) {
    case 'PENDING_ITEMS':
      return widget.series.map((item) => ({
        key: item.key,
        label: tInbox(item.key),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
    case 'BY_STATUS':
      return widget.series.map((item) => ({
        key: item.key,
        label: tStatus(item.key),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
    case 'OPENED_BY_MONTH':
      return widget.series.map((item) => ({
        key: item.key,
        label: monthLabel(item.key),
        value: item.value,
        display: format.number(item.value),
        href: null,
      }));
    case 'AVG_STAGE_DURATION':
      return widget.series.map((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: item.value,
        display: t('duration', formatDuration(item.value)),
        href: null,
        note: (
          <span className="text-xs text-muted-foreground">
            {t('samplesCount', { count: item.sampleSize })}
          </span>
        ),
      }));
    case 'VALUE_BY_SECRETARIAT':
      return widget.series.map((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: Number(item.value),
        display: formatMoney(item.value),
        href: href(item.key),
        note: item.confidentialExcluded ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Icon name="shield" />
            <span title={t('confidentialExcludedHint')}>{t('confidentialExcluded')}</span>
          </span>
        ) : undefined,
      }));
    default:
      return widget.series.map((item) => ({
        key: item.key,
        label: item.label ?? t('noLabel'),
        value: item.value,
        display: format.number(item.value),
        href: href(item.key),
      }));
  }
}

const WIDGET_TONE: Readonly<Partial<Record<DashboardWidgetKey, DashboardTone>>> = {
  OVERDUE: 'danger',
  DUE_SOON: 'warning',
};

/** `DashboardWidgetCard`: um indicador com carregamento, vazio, erro e tabela próprios. */
function DashboardWidgetCard({
  widgetKey,
  filters,
}: {
  readonly widgetKey: Exclude<DashboardWidgetKey, 'RECENT_ACTIVITY'>;
  readonly filters: DashboardFilters;
}) {
  const t = useTranslations('dashboard');
  const query = useDashboardWidget(widgetKey, filters, true);
  const [showTable, setShowTable] = useState(false);
  const widget = query.data?.data;
  const items = useBarItems(widget, filters);
  const title = t(`widgets.${widgetKey}.title`);
  const titleId = useId();
  if (query.error && describeDashboardError(query.error).kind === 'hidden') return null;
  // Filtro inválido: o resumo explica e devolve os filtros para "Todas".
  const filterProblem =
    query.error !== null &&
    ['invalidReference', 'notInSecretariat'].includes(describeDashboardError(query.error).kind);
  return (
    <article
      aria-labelledby={titleId}
      aria-busy={query.isFetching}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {widget && !isWidgetEmpty(widget) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={showTable}
            onClick={() => {
              setShowTable((current) => !current);
            }}
          >
            {showTable ? t('card.showChart') : t('card.showTable')}
          </Button>
        ) : null}
      </header>
      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('card.loading')}</span>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {query.error && !filterProblem ? (
        <CardProblem error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {widget ? (
        isWidgetEmpty(widget) ? (
          <p className="text-sm text-muted-foreground">
            {t(`widgets.${widgetKey}.empty`, {
              days: widget.widgetKey === 'DUE_SOON' ? widget.warnBeforeBusinessDays : 0,
            })}
          </p>
        ) : (
          <>
            <BarList
              items={items}
              tone={WIDGET_TONE[widgetKey] ?? 'neutral'}
              showTable={showTable}
              caption={t('card.tableCaption', { title })}
            />
            {'total' in widget && widgetKey !== 'OPENED_BY_MONTH' ? (
              <p className="text-xs text-muted-foreground">
                {t('card.total', { count: widget.total })}
              </p>
            ) : null}
          </>
        )
      ) : null}
    </article>
  );
}

/** `RecentActivityFeed`: as últimas entradas da timeline dos processos visíveis. */
function RecentActivityFeed({ filters }: { readonly filters: DashboardFilters }) {
  const t = useTranslations('dashboard');
  const { activeTenant } = useShellSession();
  const query = useDashboardWidget('RECENT_ACTIVITY', filters, true);
  const widget = query.data?.data as DashboardWidgetOf<'RECENT_ACTIVITY'> | undefined;
  const titleId = useId();
  const time = (iso: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: activeTenant.timezone,
    }).format(new Date(iso));
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={query.isFetching}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <h2 id={titleId} className="text-base font-semibold">
        {t('widgets.RECENT_ACTIVITY.title')}
      </h2>
      {query.isPending ? (
        <div role="status">
          <span className="sr-only">{t('card.loading')}</span>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {query.error && describeDashboardError(query.error).kind !== 'invalidReference' ? (
        <CardProblem error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {widget?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('widgets.RECENT_ACTIVITY.empty')}</p>
      ) : null}
      {widget && widget.items.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {widget.items.map((entry) => {
            const { message, detail } = renderTimelineEntry(entry);
            return (
              <li key={entry.id} className="flex min-w-0 flex-col gap-0.5 py-2">
                <Link
                  href={`/processos/${entry.process.id}`}
                  className="text-sm font-medium hover:underline"
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
    </section>
  );
}
