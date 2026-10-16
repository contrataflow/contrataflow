import { addCalendarDays } from '@contrataflow/types';
import type { DayCountType } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { CALENDAR_SETTINGS_READER, HOLIDAY_REPOSITORY } from './holiday-ports.js';
import type {
  CalendarSettings,
  CalendarSettingsReader,
  HolidayRepository,
} from './holiday-ports.js';
import {
  addDays,
  endOfDayInstant,
  isBusinessDay,
  listBusinessDaysBetween,
  localDateOf,
  nonBusinessDatesOf,
} from '../domain/business-calendar.js';

/**
 * API pública de calendário do módulo `catalog` para os demais módulos (DEC-041 · US-106):
 * métodos de intenção sobre a transação do chamador (`tx`), sempre do tenant do contexto. É a
 * fonte única de dias úteis — `deadlines` (US-055) e a prévia de prazo (US-047) a consomem.
 * Alterações no calendário nunca recalculam `dueAt` já gravados (RN-TEN-79).
 */
@Injectable()
export class BusinessCalendarFacade {
  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepository,
    @Inject(CALENDAR_SETTINGS_READER) private readonly settings: CalendarSettingsReader,
  ) {}

  private settingsOf(tx: TenantTx): Promise<CalendarSettings> {
    return this.settings.read(tx, requireRequestContext().tenantId ?? '');
  }

  /** Datas não úteis por feriado entre as datas (inclusive) — `OPTIONAL` conforme o tenant. */
  private async nonBusinessBetween(
    tx: TenantTx,
    settings: CalendarSettings,
    from: string,
    to: string,
  ): Promise<ReadonlySet<string>> {
    const holidays = await this.holidays.activeBetween(tx, from, to);
    return nonBusinessDatesOf(holidays, settings.optionalHolidaysAreNonBusiness);
  }

  /** Fuso IANA do tenant (`tenants.timezone`): datas locais de filtros e prazos (US-002). */
  async timezone(tx: TenantTx): Promise<string> {
    return (await this.settingsOf(tx)).timezone;
  }

  /** RN-TEN-74: a data `YYYY-MM-DD` é dia útil no calendário do tenant? */
  async isBusinessDay(tx: TenantTx, date: string): Promise<boolean> {
    const nonBusiness = await this.nonBusinessBetween(tx, await this.settingsOf(tx), date, date);
    return isBusinessDay(date, nonBusiness);
  }

  /** CAL-05: dias úteis de `from` a `to`, inclusive. */
  async listBusinessDaysBetween(tx: TenantTx, from: string, to: string): Promise<string[]> {
    const nonBusiness = await this.nonBusinessBetween(tx, await this.settingsOf(tx), from, to);
    return listBusinessDaysBetween(from, to, nonBusiness);
  }

  /**
   * Dias úteis decorridos entre dois instantes (US-041 · `RuleContext.stage.businessDaysInStage`):
   * os dias úteis DEPOIS do dia local de `from` até o dia local de `to`, inclusive, no fuso do
   * tenant — quem entrou na etapa hoje está há 0 dia útil nela.
   */
  async businessDaysElapsed(tx: TenantTx, from: Date, to: Date): Promise<number> {
    const settings = await this.settingsOf(tx);
    const start = addCalendarDays(localDateOf(from, settings.timezone), 1);
    const end = localDateOf(to, settings.timezone);
    if (start > end) return 0;
    const nonBusiness = await this.nonBusinessBetween(tx, settings, start, end);
    return listBusinessDaysBetween(start, end, nonBusiness).length;
  }

  /**
   * RN-TEN-78: soma `days` dias úteis (ou corridos) ao DIA LOCAL de `from` e devolve o fim desse
   * dia (`23:59:59.999`) no fuso do tenant, como instante UTC. Quem calcula `dueAt` guarda esse
   * valor e não o recalcula quando o calendário muda.
   */
  async addBusinessDays(
    tx: TenantTx,
    from: Date,
    days: number,
    type: DayCountType = 'BUSINESS',
  ): Promise<Date> {
    const settings = await this.settingsOf(tx);
    const fromDate = localDateOf(from, settings.timezone);
    // Janela folgada: no pior caso 5 dias úteis a cada 7 corridos, mais um ano de feriados.
    const nonBusiness =
      type === 'CALENDAR'
        ? new Set<string>()
        : await this.nonBusinessBetween(
            tx,
            settings,
            fromDate,
            addCalendarDays(fromDate, days * 2 + 366),
          );
    return endOfDayInstant(addDays(fromDate, days, type, nonBusiness), settings.timezone);
  }
}
