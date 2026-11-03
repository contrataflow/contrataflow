'use client';

import type { HolidayScope } from '@contrataflow/types';
import { HOLIDAY_SCOPES, localDateOf } from '@contrataflow/types';
import {
  Alert,
  Building2,
  Button,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
  toast,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import {
  countByScope,
  holidaysByDate,
  nonBusinessDates,
  summarizeYear,
  yearOptions,
} from './calendar-model';
import type { HolidayFilter } from './calendar-model';
import {
  CALENDAR_STALE_TIME_MS,
  calendarKeys,
  deleteHoliday,
  fetchBusinessDaysOfYear,
  fetchHolidays,
  updateHoliday,
} from './calendar.api';
import { HolidayFormDialog } from './holiday-form-dialog';
import { HolidayList } from './holiday-list';
import { HolidayMarker } from './holiday-marker';
import { YearGrid } from './year-grid';

type Banner = 'conflict' | 'unavailable' | 'generic' | null;

/**
 * SCR-110 — Administração › Calendário (`/admin/calendario` · US-106 · prd-6 §2.6, padrão do
 * Microlegis): ano em destaque com anterior/próximo, "Novo feriado" no cabeçalho, mostradores do ano
 * (dias úteis, sem expediente, feriados da instituição, pontos facultativos), legenda por tipo, doze
 * meses em grade (cada dia abre o diálogo de edição ou de cadastro) e a lista lateral com filtro por
 * tipo e o menu ⋯ por feriado. Mostradores: CAL-01 (feriados) + CAL-05 (datas úteis do ano, que já
 * aplica `calendar.optionalHolidaysAreNonBusiness`); sem o CAL-05, o cálculo cai no padrão da
 * configuração. Leitura é capacidade implícita do vínculo ativo; escrita só com `CALENDAR_MANAGE`
 * (a API decide cada requisição) e feriado de sistema nunca oferece "Excluir".
 */
export function CalendarView() {
  const t = useTranslations('calendar');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const queryClient = useQueryClient();
  // "Hoje" é o dia local no fuso do tenant (DEC-003), o mesmo da contagem de prazos.
  const today = localDateOf(new Date(), session.activeTenant.timezone);
  const currentYear = Number(today.slice(0, 4));
  const canManage = usePermission('CALENDAR_MANAGE').allowed;
  const [year, setYear] = useState(currentYear);
  const [filter, setFilter] = useState<HolidayFilter>('all');
  const [creating, setCreating] = useState<{ readonly date?: string } | null>(null);
  const [editing, setEditing] = useState<HolidayDto | null>(null);
  const [deactivating, setDeactivating] = useState<HolidayDto | null>(null);
  const [deleting, setDeleting] = useState<HolidayDto | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  const holidays = useQuery({
    queryKey: calendarKeys.holidays(tenantId, year),
    queryFn: async ({ signal }) => (await fetchHolidays(year, signal)).data,
    staleTime: CALENDAR_STALE_TIME_MS,
  });
  const businessDays = useQuery({
    queryKey: calendarKeys.businessDays(tenantId, year),
    queryFn: async ({ signal }) => (await fetchBusinessDaysOfYear(year, signal)).data.dates,
    staleTime: CALENDAR_STALE_TIME_MS,
    retry: false,
    throwOnError: false,
  });

  const view = useMemo(() => {
    const list = holidays.data ?? [];
    const nonBusiness = nonBusinessDates(year, list, businessDays.data);
    return {
      nonBusiness,
      byDate: holidaysByDate(list),
      summary: summarizeYear(year, list, nonBusiness),
      scopes: countByScope(list),
    };
  }, [holidays.data, businessDays.data, year]);

  const changeYear = (next: number) => {
    setYear(next);
    setBanner(null);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all(tenantId) });
  };
  const reload = () => {
    setBanner(null);
    refresh();
  };
  /** 412 vindo do diálogo: avisa e relê a lista (a versão do feriado mudou). */
  const onConflict = () => {
    setBanner('conflict');
    refresh();
  };

  const failure = (error: unknown): void => {
    if (isApiError(error) && (error.status === 412 || error.status === 404)) {
      setBanner('conflict');
    } else {
      setBanner(isApiError(error) && error.status === 503 ? 'unavailable' : 'generic');
    }
    refresh();
  };

  const setActive = useMutation({
    mutationFn: ({ holiday, isActive }: { holiday: HolidayDto; isActive: boolean }) =>
      updateHoliday(holiday.id, { isActive }, holiday.version),
    onSuccess: (result, { isActive }) => {
      setBanner(null);
      setDeactivating(null);
      toast({
        title: t(isActive ? 'toast.activated' : 'toast.deactivated', { name: result.data.name }),
        tone: 'success',
      });
      refresh();
    },
    onError: (error) => {
      setDeactivating(null);
      failure(error);
    },
  });

  const remove = useMutation({
    mutationFn: (holiday: HolidayDto) => deleteHoliday(holiday.id, holiday.version),
    onSuccess: (_result, holiday) => {
      setBanner(null);
      setDeleting(null);
      toast({ title: t('toast.deleted', { name: holiday.name }), tone: 'success' });
      refresh();
    },
    onError: (error) => {
      setDeleting(null);
      failure(error);
    },
  });

  const saving = setActive.isPending || remove.isPending;
  const years = yearOptions(currentYear, year);
  const newButton = (
    <Can permission="CALENDAR_MANAGE">
      <Button
        iconLeft={<Plus />}
        onClick={() => {
          setCreating({});
        }}
      >
        {t('list.new')}
      </Button>
    </Can>
  );

  /** Dia da grade: edita o feriado do dia (o ativo primeiro) ou cadastra um novo nessa data. */
  const openDay = (date: string) => {
    const [first] = view.byDate.get(date) ?? [];
    if (first) setEditing(first);
    else setCreating({ date });
  };

  const { summary } = view;
  const optionalContext =
    summary.optionalCountAsBusiness === null
      ? t('stats.optionalNone')
      : summary.optionalCountAsBusiness
        ? t('stats.optionalBusiness')
        : t('stats.optionalNonBusiness');

  return (
    <section className="flex flex-col gap-6">
      <AppPageHeader
        section="admin"
        title={t('title')}
        description={t('description')}
        actions={newButton}
      />

      {holidays.error && isApiError(holidays.error) && holidays.error.status === 403 ? (
        <Alert tone="error" title={t('errors.permission')} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('year.previous')}
                disabled={!years.includes(year - 1)}
                onClick={() => {
                  changeYear(year - 1);
                }}
                className="md:size-9"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Select
                value={String(year)}
                onValueChange={(next) => {
                  changeYear(Number(next));
                }}
              >
                <SelectTrigger
                  aria-label={t('year.label')}
                  className="h-11 w-28 text-lg font-bold tabular-nums md:h-9"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('year.next')}
                disabled={!years.includes(year + 1)}
                onClick={() => {
                  changeYear(year + 1);
                }}
                className="md:size-9"
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {saving ? t('list.saving') : ''}
            </p>
          </div>

          {banner ? (
            <Alert
              tone={banner === 'conflict' ? 'warning' : 'error'}
              title={
                banner === 'conflict'
                  ? t('conflict.title')
                  : banner === 'unavailable'
                    ? t('errors.unavailable')
                    : t('errors.generic')
              }
            >
              <Button variant="secondary" size="sm" onClick={reload}>
                {banner === 'conflict' ? t('conflict.reload') : t('list.retry')}
              </Button>
            </Alert>
          ) : null}

          {holidays.isPending ? (
            <div role="status" className="flex flex-col gap-3">
              <span className="sr-only">{t('list.loading')}</span>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
              <Skeleton className="h-64 w-full" />
            </div>
          ) : null}

          {holidays.isError ? (
            <Alert tone="error" title={t('list.loadFailed')}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void holidays.refetch();
                }}
              >
                {t('list.retry')}
              </Button>
            </Alert>
          ) : null}

          {holidays.data ? (
            <>
              <section aria-label={t('stats.label', { year })}>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatTile
                    icon={<CalendarDays aria-hidden="true" />}
                    label={t('stats.businessDays')}
                    value={summary.businessDays}
                    context={t('stats.businessDaysHint')}
                  />
                  <StatTile
                    icon={<Clock aria-hidden="true" />}
                    label={t('stats.noWork')}
                    value={summary.noWorkDays}
                    context={t('stats.noWorkHint')}
                  />
                  <StatTile
                    icon={<Building2 aria-hidden="true" />}
                    label={t('stats.institution')}
                    value={summary.institutionHolidays}
                    context={t('stats.institutionHint')}
                  />
                  <StatTile
                    icon={<CircleDot aria-hidden="true" />}
                    label={t('stats.optional')}
                    value={summary.optionalHolidays}
                    context={optionalContext}
                  />
                </div>
              </section>

              <Legend scopes={view.scopes} />

              <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22.5rem]">
                <section aria-labelledby="calendario-meses" className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 id="calendario-meses" className="text-base font-bold text-foreground">
                      {t('months.title', { year })}
                    </h2>
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {canManage ? t('months.hint') : t('months.hintReadOnly')}
                    </p>
                  </div>
                  <YearGrid
                    year={year}
                    today={today}
                    byDate={view.byDate}
                    nonBusiness={view.nonBusiness}
                    onDay={canManage ? openDay : undefined}
                  />
                </section>
                <HolidayList
                  year={year}
                  holidays={holidays.data}
                  nonBusiness={view.nonBusiness}
                  filter={filter}
                  onFilterChange={setFilter}
                  canManage={canManage}
                  busy={saving}
                  emptyAction={newButton}
                  onEdit={setEditing}
                  onDeactivate={setDeactivating}
                  onActivate={(holiday) => {
                    setActive.mutate({ holiday, isActive: true });
                  }}
                  onDelete={setDeleting}
                />
              </div>
            </>
          ) : null}
        </div>
      )}

      <HolidayFormDialog
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
        defaultDate={creating?.date}
        onConflict={onConflict}
      />
      <HolidayFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        holiday={editing ?? undefined}
        onConflict={onConflict}
      />

      <Dialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('deactivate.title', { name: deactivating?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('deactivate.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeactivating(null);
              }}
            >
              {t('deactivate.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={setActive.isPending}
              aria-busy={setActive.isPending}
              onClick={() => {
                if (deactivating) setActive.mutate({ holiday: deactivating, isActive: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('delete.title', { name: deleting?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {t('delete.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              aria-busy={remove.isPending}
              onClick={() => {
                if (deleting) remove.mutate(deleting);
              }}
            >
              {t('delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Legenda em chips: um por tipo de feriado (marcador + nome + contagem do ano) e as marcas do dia. */
function Legend({ scopes }: { readonly scopes: Readonly<Record<HolidayScope, number>> }) {
  const t = useTranslations('calendar');
  const chip = (key: string, mark: ReactNode, label: string, count?: number) => (
    <li
      key={key}
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-surface pr-3 pl-2 text-[0.8125rem] font-semibold text-foreground"
    >
      <span className="flex size-5 items-center justify-center">{mark}</span>
      {label}
      {count === undefined ? null : (
        <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      )}
    </li>
  );
  return (
    <section aria-labelledby="calendario-legenda" className="flex flex-col gap-2">
      <h2
        id="calendario-legenda"
        className="text-[0.6875rem] font-bold tracking-[0.12em] text-muted-foreground uppercase"
      >
        {t('legend.title')}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {HOLIDAY_SCOPES.map((scope) =>
          chip(scope, <HolidayMarker scope={scope} />, t(`scopeLong.${scope}`), scopes[scope]),
        )}
        {chip(
          'naoUtil',
          <span aria-hidden="true" className="size-4 rounded-[0.25rem] bg-primary-soft" />,
          t('legend.nonBusiness'),
        )}
        {chip(
          'util',
          <span
            aria-hidden="true"
            className="size-4 rounded-[0.25rem] outline-1 -outline-offset-1 outline-border outline-dashed"
          />,
          t('legend.business'),
        )}
        {chip(
          'fimDeSemana',
          <span aria-hidden="true" className="size-4 rounded-[0.25rem] bg-muted" />,
          t('legend.weekend'),
        )}
        {chip(
          'hoje',
          <span
            aria-hidden="true"
            className="size-4 rounded-[0.25rem] ring-2 ring-foreground ring-inset"
          />,
          t('legend.today'),
        )}
      </ul>
    </section>
  );
}
