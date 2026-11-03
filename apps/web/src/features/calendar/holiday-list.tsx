'use client';

import {
  CalendarDays,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  StatusChip,
  cx,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import {
  HOLIDAY_FILTERS,
  dayKind,
  groupByMonth,
  matchesFilter,
  monthName,
  weekdayLong,
} from './calendar-model';
import type { HolidayFilter } from './calendar-model';
import { HolidayMarker } from './holiday-marker';

export interface HolidayListProps {
  readonly year: number;
  readonly holidays: readonly HolidayDto[];
  readonly nonBusiness: ReadonlySet<string>;
  readonly filter: HolidayFilter;
  readonly onFilterChange: (filter: HolidayFilter) => void;
  readonly canManage: boolean;
  readonly busy: boolean;
  /** Ação do vazio (ex.: "Novo feriado"), só quando não há feriado no ano. */
  readonly emptyAction?: ReactNode;
  readonly onEdit: (holiday: HolidayDto) => void;
  readonly onDeactivate: (holiday: HolidayDto) => void;
  readonly onActivate: (holiday: HolidayDto) => void;
  readonly onDelete: (holiday: HolidayDto) => void;
}

/**
 * Lista lateral "Feriados de {ano}" (prd-6 §2.6 · SCR-110 · US-106), no lugar da tabela: filtro
 * por tipo (Todos · Públicos · Da instituição · Facultativos, com a contagem), itens em ordem de
 * data agrupados por mês — data em destaque (botão que abre a edição), nome, tipo e se conta como
 * dia útil, selos "Padrão do sistema"/"Recorrente"/"Inativo" — e o menu ⋯ com Editar,
 * Desativar/Ativar e Excluir, só com `CALENDAR_MANAGE` (a API decide cada requisição). Feriado de
 * sistema nunca oferece "Excluir" (FA-01 · RN-TEN-77).
 */
export function HolidayList({
  year,
  holidays,
  nonBusiness,
  filter,
  onFilterChange,
  canManage,
  busy,
  emptyAction,
  onEdit,
  onDeactivate,
  onActivate,
  onDelete,
}: HolidayListProps) {
  const t = useTranslations('calendar');
  const visible = holidays.filter((holiday) => matchesFilter(holiday, filter));
  const headingId = `feriados-${String(year)}`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col rounded-card bg-surface shadow-card"
    >
      <div className="flex flex-col gap-1 border-b border-border px-5 pt-4 pb-3.5">
        <h2 id={headingId} className="text-base font-bold text-foreground">
          {t('list.title', { year })}
        </h2>
        <p className="text-[0.8125rem] text-muted-foreground">{t('list.hint')}</p>
      </div>

      {holidays.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={<CalendarDays />}
            title={t('list.empty')}
            description={t('list.emptyHint')}
            action={emptyAction}
          />
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label={t('list.filterLabel')}
            className="flex flex-wrap gap-1.5 border-b border-border px-5 py-3"
          >
            {HOLIDAY_FILTERS.map((option) => {
              const count = holidays.filter((holiday) => matchesFilter(holiday, option)).length;
              const pressed = option === filter;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => {
                    onFilterChange(option);
                  }}
                  className={cx(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    pressed
                      ? 'border-primary bg-primary-soft text-primary-soft-foreground'
                      : 'border-border text-foreground hover:bg-muted',
                  )}
                >
                  {t(`list.filters.${option}`)}
                  <span className="text-xs tabular-nums opacity-80">{count}</span>
                </button>
              );
            })}
          </div>

          {visible.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {t('list.filterEmpty', { year })}
            </p>
          ) : (
            <div className="flex flex-col px-5 pb-2">
              {groupByMonth(visible).map((group) => (
                <section
                  key={group.month}
                  aria-labelledby={`${headingId}-mes-${String(group.month + 1)}`}
                  className="flex flex-col border-b border-border py-3 last:border-b-0"
                >
                  <h3
                    id={`${headingId}-mes-${String(group.month + 1)}`}
                    className="pb-1 text-[0.6875rem] font-bold tracking-[0.12em] text-muted-foreground uppercase"
                  >
                    {monthName(group.month)}
                  </h3>
                  <ul className="flex flex-col">
                    {group.holidays.map((holiday) => (
                      <HolidayItem
                        key={holiday.id}
                        holiday={holiday}
                        kind={dayKind(holiday.date, nonBusiness)}
                        canManage={canManage}
                        busy={busy}
                        onEdit={onEdit}
                        onDeactivate={onDeactivate}
                        onActivate={onActivate}
                        onDelete={onDelete}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HolidayItem({
  holiday,
  kind,
  canManage,
  busy,
  onEdit,
  onDeactivate,
  onActivate,
  onDelete,
}: {
  readonly holiday: HolidayDto;
  readonly kind: ReturnType<typeof dayKind>;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onEdit: (holiday: HolidayDto) => void;
  readonly onDeactivate: (holiday: HolidayDto) => void;
  readonly onActivate: (holiday: HolidayDto) => void;
  readonly onDelete: (holiday: HolidayDto) => void;
}) {
  const t = useTranslations('calendar');
  const dateText = `${holiday.date.slice(8)}/${holiday.date.slice(5, 7)} · ${weekdayLong(holiday.date)}`;
  const effect = holiday.isActive ? kind : 'business';

  return (
    <li
      data-holiday={holiday.id}
      className={cx('flex items-start gap-3 py-2', !holiday.isActive && 'text-muted-foreground')}
    >
      <span className="mt-1 flex size-6 flex-none items-center justify-center rounded-[0.375rem] bg-muted">
        <HolidayMarker scope={holiday.scope} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {canManage ? (
          <button
            type="button"
            onClick={() => {
              onEdit(holiday);
            }}
            aria-label={t('list.openDate', { date: dateText, name: holiday.name })}
            className="self-start text-left text-sm font-bold text-primary tabular-nums underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {dateText}
          </button>
        ) : (
          <span className="text-sm font-bold tabular-nums">{dateText}</span>
        )}
        <span className="text-sm font-semibold text-foreground">{holiday.name}</span>
        <span className="text-xs text-muted-foreground">
          {t(`scopeLong.${holiday.scope}`)} · {t(`effect.${effect}`)}
        </span>
        {holiday.isSystem || holiday.isRecurring || !holiday.isActive ? (
          <span className="flex flex-wrap gap-1.5 pt-1">
            {holiday.isActive ? null : (
              <StatusChip tone="neutral">{t('badges.inactive')}</StatusChip>
            )}
            {holiday.isSystem ? <StatusChip tone="info">{t('badges.system')}</StatusChip> : null}
            {holiday.isRecurring ? (
              <StatusChip tone="neutral">{t('badges.recurring')}</StatusChip>
            ) : null}
          </span>
        ) : null}
      </span>
      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('actions.menu', { name: holiday.name })}
              className="inline-grid size-11 flex-none place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
            >
              <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                onEdit(holiday);
              }}
            >
              {t('actions.editLabel')}
            </DropdownMenuItem>
            {holiday.isActive ? (
              <DropdownMenuItem
                onSelect={() => {
                  onDeactivate(holiday);
                }}
              >
                {t('actions.deactivateLabel')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => {
                  onActivate(holiday);
                }}
              >
                {t('actions.activateLabel')}
              </DropdownMenuItem>
            )}
            {holiday.isSystem ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    onDelete(holiday);
                  }}
                >
                  {t('actions.deleteLabel')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
