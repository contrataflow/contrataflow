'use client';

import { Button } from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { Can } from '@/lib/permissions/can';

import { formatHolidayDate, weekdayOf } from './calendar-model';

function Badge({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: 'muted' | 'ok' | 'system' | 'info';
}) {
  const classes = {
    ok: 'bg-success-soft text-foreground',
    muted: 'bg-muted text-muted-foreground',
    system: 'border border-border bg-surface text-foreground',
    info: 'border border-border bg-muted text-foreground',
  } as const;
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${classes[tone]}`}
    >
      {children}
    </span>
  );
}

export interface HolidayTableProps {
  readonly caption: string;
  readonly holidays: readonly HolidayDto[];
  readonly busy: boolean;
  readonly onEdit: (holiday: HolidayDto) => void;
  readonly onDeactivate: (holiday: HolidayDto) => void;
  readonly onActivate: (holiday: HolidayDto) => void;
  readonly onDelete: (holiday: HolidayDto) => void;
}

/**
 * `HolidayTable` (SCR-110 · US-106 · passo 1): data, nome, escopo, selos "Padrão do sistema" e
 * "Recorrente" e situação. Feriado de sistema nunca oferece "Excluir" (FA-01 · RN-TEN-77), só
 * desativar; as ações aparecem só com `CALENDAR_MANAGE` (a API decide cada requisição).
 */
export function HolidayTable({
  caption,
  holidays,
  busy,
  onEdit,
  onDeactivate,
  onActivate,
  onDelete,
}: HolidayTableProps) {
  const t = useTranslations('calendar');

  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-3 py-2">
              {t('table.date')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.name')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.scope')}
            </th>
            <th scope="col" className="px-3 py-2">
              {t('table.status')}
            </th>
            <Can permission="CALENDAR_MANAGE">
              <th scope="col" className="px-3 py-2">
                {t('table.actions')}
              </th>
            </Can>
          </tr>
        </thead>
        <tbody>
          {holidays.map((holiday) => (
            <tr
              key={holiday.id}
              className={`border-t border-border align-top ${
                holiday.isActive ? '' : 'text-muted-foreground'
              }`}
            >
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                {formatHolidayDate(holiday.date)}{' '}
                <span className="text-xs text-muted-foreground">{weekdayOf(holiday.date)}</span>
              </td>
              <th scope="row" className="px-3 py-2 font-medium">
                {holiday.name}
              </th>
              <td className="px-3 py-2">{t(`scopes.${holiday.scope}`)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  <Badge tone={holiday.isActive ? 'ok' : 'muted'}>
                    {holiday.isActive ? t('badges.active') : t('badges.inactive')}
                  </Badge>
                  {holiday.isSystem ? <Badge tone="system">{t('badges.system')}</Badge> : null}
                  {holiday.isRecurring ? <Badge tone="info">{t('badges.recurring')}</Badge> : null}
                </div>
              </td>
              <Can permission="CALENDAR_MANAGE">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t('actions.edit', { name: holiday.name })}
                      onClick={() => {
                        onEdit(holiday);
                      }}
                    >
                      {t('actions.editLabel')}
                    </Button>
                    {holiday.isActive ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.deactivate', { name: holiday.name })}
                        onClick={() => {
                          onDeactivate(holiday);
                        }}
                      >
                        {t('actions.deactivateLabel')}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.activate', { name: holiday.name })}
                        disabled={busy}
                        onClick={() => {
                          onActivate(holiday);
                        }}
                      >
                        {t('actions.activateLabel')}
                      </Button>
                    )}
                    {holiday.isSystem ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('actions.delete', { name: holiday.name })}
                        onClick={() => {
                          onDelete(holiday);
                        }}
                      >
                        {t('actions.deleteLabel')}
                      </Button>
                    )}
                  </div>
                </td>
              </Can>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
