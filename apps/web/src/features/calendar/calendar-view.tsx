'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { yearOptions } from './calendar-model';
import {
  CALENDAR_STALE_TIME_MS,
  calendarKeys,
  deleteHoliday,
  fetchHolidays,
  updateHoliday,
} from './calendar.api';
import { HolidayFormDialog } from './holiday-form-dialog';
import { HolidayTable } from './holiday-table';

type Banner = 'conflict' | 'unavailable' | 'generic' | null;

/**
 * SCR-110 — Administração › Calendário (`/admin/calendario` · US-106): seletor de ano, tabela de
 * feriados (CAL-01), cadastro e edição (CAL-02/03), desativação/ativação e exclusão com `If-Match`
 * (CAL-03/04). Leitura é capacidade implícita do vínculo ativo; as ações de escrita só aparecem
 * com `CALENDAR_MANAGE` (a API decide cada requisição) e feriado de sistema nunca oferece
 * "Excluir". Estados: skeleton, vazio, erro com "Tentar novamente", conflito de versão e
 * indicador de salvamento.
 */
export function CalendarView() {
  const t = useTranslations('calendar');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const yearFieldId = useId();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<HolidayDto | null>(null);
  const [deactivating, setDeactivating] = useState<HolidayDto | null>(null);
  const [deleting, setDeleting] = useState<HolidayDto | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  const holidays = useQuery({
    queryKey: calendarKeys.holidays(tenantId, year),
    queryFn: async ({ signal }) => (await fetchHolidays(year, signal)).data,
    staleTime: CALENDAR_STALE_TIME_MS,
  });

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

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

      {holidays.error && isApiError(holidays.error) && holidays.error.status === 403 ? (
        <Alert tone="error" title={t('errors.permission')} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={yearFieldId} className="text-sm font-medium">
                {t('year.label')}
              </label>
              <select
                id={yearFieldId}
                className="h-10 rounded-control border border-border bg-surface px-3 text-sm"
                value={year}
                onChange={(event) => {
                  setYear(Number(event.target.value));
                  setBanner(null);
                }}
              >
                {yearOptions(currentYear, year).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <p role="status" className="text-sm text-muted-foreground">
                {saving ? t('list.saving') : ''}
              </p>
              <Can permission="CALENDAR_MANAGE">
                <Button
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  {t('list.new')}
                </Button>
              </Can>
            </div>
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
            <div role="status" className="flex flex-col gap-2">
              <span className="sr-only">{t('list.loading')}</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
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

          {holidays.data?.length === 0 ? (
            <div className="rounded-card border border-dashed border-border p-6 text-center">
              <p className="font-medium">{t('list.empty')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('list.emptyHint')}</p>
            </div>
          ) : null}

          {holidays.data && holidays.data.length > 0 ? (
            <HolidayTable
              caption={t('table.caption', { year })}
              holidays={holidays.data}
              busy={saving}
              onEdit={setEditing}
              onDeactivate={setDeactivating}
              onActivate={(holiday) => {
                setActive.mutate({ holiday, isActive: true });
              }}
              onDelete={setDeleting}
            />
          ) : null}
        </div>
      )}

      <HolidayFormDialog open={creating} onOpenChange={setCreating} onConflict={onConflict} />
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
