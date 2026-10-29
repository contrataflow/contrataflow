'use client';

import {
  Alert,
  Button,
  Calendar,
  CalendarDays,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Field,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  fromIsoDate,
  toast,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
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
 * SCR-110 — Administração › Calendário (`/admin/calendario` · US-106 · prd-5): seletor de ano, o
 * `Calendar` do kit com os feriados ativos em destaque e, ao lado (empilhados em tela estreita), a
 * lista do ano (CAL-01) com menu ⋯ por linha; "Novo feriado" é a ação do cabeçalho. Cadastro e
 * edição (CAL-02/03) num `Dialog`, desativação/ativação e exclusão com `If-Match` (CAL-03/04). Leitura é capacidade implícita do vínculo ativo; as ações de escrita só aparecem
 * com `CALENDAR_MANAGE` (a API decide cada requisição) e feriado de sistema nunca oferece
 * "Excluir". Estados: skeleton, vazio, erro com "Tentar novamente", conflito de versão e
 * indicador de salvamento.
 */
export function CalendarView() {
  const t = useTranslations('calendar');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(() => new Date());
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

  // Dias em destaque no calendário: só os feriados ativos (os inativos voltam a contar como úteis).
  const markedDays = useMemo(
    () =>
      (holidays.data ?? [])
        .filter((holiday) => holiday.isActive)
        .flatMap((holiday) => fromIsoDate(holiday.date) ?? []),
    [holidays.data],
  );

  const changeYear = (next: number) => {
    setYear(next);
    setMonth(next === currentYear ? new Date() : new Date(next, 0, 1));
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

  return (
    <section className="flex flex-col gap-6">
      <AppPageHeader
        section="admin"
        title={t('title')}
        description={t('description')}
        actions={
          <Can permission="CALENDAR_MANAGE">
            <Button
              iconLeft={<Plus />}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('list.new')}
            </Button>
          </Can>
        }
      />

      {holidays.error && isApiError(holidays.error) && holidays.error.status === 403 ? (
        <Alert tone="error" title={t('errors.permission')} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Field label={t('year.label')} className="w-40">
              <Select
                value={String(year)}
                onValueChange={(next) => {
                  changeYear(Number(next));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions(currentYear, year).map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
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
            <EmptyState
              icon={<CalendarDays />}
              title={t('list.empty')}
              description={t('list.emptyHint')}
              action={
                <Can permission="CALENDAR_MANAGE">
                  <Button
                    iconLeft={<Plus />}
                    onClick={() => {
                      setCreating(true);
                    }}
                  >
                    {t('list.new')}
                  </Button>
                </Can>
              }
            />
          ) : null}

          {holidays.data && holidays.data.length > 0 ? (
            <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[auto_minmax(0,1fr)]">
              <Card
                title={t('view.calendarLabel', { year })}
                description={t('view.legend', { year })}
                className="min-w-0 xl:w-[24rem]"
              >
                <Calendar
                  month={month}
                  onMonthChange={setMonth}
                  startMonth={new Date(year, 0, 1)}
                  endMonth={new Date(year, 11, 1)}
                  modifiers={{ holiday: markedDays }}
                  // Sem modo de seleção o dia é texto na própria célula (sem botão): o destaque
                  // vai na célula.
                  modifiersClassNames={{
                    holiday: 'rounded-full bg-primary-soft font-bold text-primary-soft-foreground',
                  }}
                  className="mx-auto"
                />
              </Card>
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
            </div>
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
