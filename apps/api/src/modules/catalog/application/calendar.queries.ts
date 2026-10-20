import { addCalendarDays } from '@contrataflow/types';
import { MAX_BUSINESS_DAYS_RANGE } from '@contrataflow/validation';
import type {
  AddBusinessDays,
  AddBusinessDaysResult,
  BusinessDaysQuery,
  BusinessDaysResult,
  HolidayDto,
  HolidayListQuery,
} from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';

import { BusinessCalendarFacade } from './business-calendar.facade.js';
import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogTransactions } from './catalog-ports.js';
import { CALENDAR_SETTINGS_READER, HOLIDAY_REPOSITORY } from './holiday-ports.js';
import type { CalendarSettingsReader, HolidayRepository } from './holiday-ports.js';
import { businessDaysRangeInvalid } from './holiday.errors.js';
import { toHolidayDto } from './holiday.view.js';
import { localDateOf } from '../domain/business-calendar.js';

export interface HolidayListResult {
  readonly items: readonly HolidayDto[];
  readonly totalItems: number;
}

/**
 * `ListHolidaysQuery` — CAL-01 (US-106): capacidade implícita de qualquer vínculo ativo; feriados
 * (ativos e inativos) do ano por data e nome. Sem `year`, o ano corrente no fuso do tenant.
 */
@Injectable()
export class ListHolidaysQuery {
  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepository,
    @Inject(CALENDAR_SETTINGS_READER) private readonly settings: CalendarSettingsReader,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
  ) {}

  execute(query: HolidayListQuery): Promise<HolidayListResult> {
    return this.transactions.read(async (tx) => {
      const year =
        query.year ??
        Number(
          localDateOf(
            this.clock(),
            (await this.settings.read(tx, requireRequestContext().tenantId ?? '')).timezone,
          ).slice(0, 4),
        );
      const page = await this.holidays.list(tx, {
        year,
        page: query.page,
        pageSize: query.pageSize,
      });
      return { items: page.items.map(toHolidayDto), totalItems: page.totalItems };
    });
  }
}

/**
 * `BusinessDaysQuery` — CAL-05 (US-106 · fluxo principal, passo 6): dias úteis entre duas datas
 * (inclusive), conforme os feriados do tenant. Leitura sem efeito colateral.
 */
@Injectable()
export class BusinessDaysQueryHandler {
  constructor(
    private readonly calendar: BusinessCalendarFacade,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
  ) {}

  execute(query: BusinessDaysQuery): Promise<BusinessDaysResult> {
    if (query.to < query.from) throw businessDaysRangeInvalid('INVERTED');
    if (query.to > addCalendarDays(query.from, MAX_BUSINESS_DAYS_RANGE)) {
      throw businessDaysRangeInvalid('TOO_LONG');
    }
    return this.transactions.read(async (tx) => {
      const dates = await this.calendar.listBusinessDaysBetween(tx, query.from, query.to);
      return { businessDays: dates.length, dates };
    });
  }
}

/**
 * `AddBusinessDaysQuery` — CAL-06 (US-106 · RN-TEN-78): soma `businessDays` dias úteis (ou
 * corridos, `dayCountType = CALENDAR`) ao dia local de `fromDateTime` e devolve o fim desse dia
 * (`23:59:59.999` no fuso do tenant) em UTC. Consumido por US-055 (`dueAt`) e US-047 (prévia).
 * Leitura: sem auditoria nem evento; repetir a chamada não duplica efeitos (idempotente).
 */
@Injectable()
export class AddBusinessDaysQuery {
  constructor(
    private readonly calendar: BusinessCalendarFacade,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
  ) {}

  execute(body: AddBusinessDays): Promise<AddBusinessDaysResult> {
    return this.transactions.read(async (tx) => {
      const due = await this.calendar.addBusinessDays(
        tx,
        new Date(body.fromDateTime),
        body.businessDays,
        body.dayCountType ?? 'BUSINESS',
      );
      return { dueDateTime: due.toISOString() };
    });
  }
}
