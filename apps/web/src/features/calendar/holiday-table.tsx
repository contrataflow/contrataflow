'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contrataflow/ui';
import type { HolidayDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { usePermission } from '@/lib/permissions/use-permission';

import { formatHolidayDate, weekdayOf } from './calendar-model';

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
 * `HolidayTable` (SCR-110 · US-106 · passo 1 · prd-5): data, feriado (nome em negrito; escopo e
 * selos "Padrão do sistema" e "Recorrente" na linha secundária) e situação. "Editar", "Desativar"/
 * "Ativar" e "Excluir" ficam no menu ⋯ da linha, só com `CALENDAR_MANAGE` (a API decide cada
 * requisição). Feriado de sistema nunca oferece "Excluir" (FA-01 · RN-TEN-77), só desativar.
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
  const canManage = usePermission('CALENDAR_MANAGE').allowed;

  return (
    <TableContainer label={caption}>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHead>
          <Tr>
            <Th>{t('table.date')}</Th>
            <Th>{t('table.name')}</Th>
            <Th>{t('table.status')}</Th>
            {canManage ? (
              <Th className="w-12">
                <span className="sr-only">{t('table.actions')}</span>
              </Th>
            ) : null}
          </Tr>
        </TableHead>
        <TableBody>
          {holidays.map((holiday) => (
            <Tr key={holiday.id} className={holiday.isActive ? undefined : 'text-muted-foreground'}>
              <Td className="whitespace-nowrap tabular-nums">
                <span className="block font-semibold">{formatHolidayDate(holiday.date)}</span>
                <span className="text-xs text-muted-foreground">{weekdayOf(holiday.date)}</span>
              </Td>
              <th scope="row" className="px-3.5 py-3 text-left font-normal">
                <span className="block font-bold">{holiday.name}</span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{t(`scopes.${holiday.scope}`)}</span>
                  {holiday.isSystem ? <span>{t('badges.system')}</span> : null}
                  {holiday.isRecurring ? <span>{t('badges.recurring')}</span> : null}
                </span>
              </th>
              <Td>
                <StatusChip tone={holiday.isActive ? 'success' : 'neutral'}>
                  {holiday.isActive ? t('badges.active') : t('badges.inactive')}
                </StatusChip>
              </Td>
              {canManage ? (
                <Td className="w-12 py-1.5 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('actions.menu', { name: holiday.name })}
                        className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
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
                </Td>
              ) : null}
            </Tr>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
