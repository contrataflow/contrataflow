import { HOLIDAY_CHANGES } from '@contrataflow/types';
import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * `HolidayChanged` (events.md §4.5 · US-106): um evento no commit de criar, editar ou excluir
 * feriado. Consumido pelo `ConfigCacheInvalidator` (legenda C — calendário em cache por ano).
 */
export const HolidayChanged = defineDomainEvent({
  eventType: 'HolidayChanged',
  eventVersion: 1,
  aggregateType: 'Holiday',
  payload: z.strictObject({
    holidayId: z.uuid(),
    date: z.iso.date(),
    change: z.enum(HOLIDAY_CHANGES),
  }),
  routingKey: 'catalog.holiday_changed',
});
