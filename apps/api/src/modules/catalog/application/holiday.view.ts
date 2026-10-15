import type { HolidayDto } from '@contrataflow/validation';

import type { Holiday } from '../domain/holiday.js';

/** `Holiday` → resposta de CAL-01..03 (`date` `YYYY-MM-DD`). */
export function toHolidayDto(holiday: Holiday): HolidayDto {
  return {
    id: holiday.id,
    date: holiday.date,
    name: holiday.name,
    scope: holiday.scope,
    isRecurring: holiday.isRecurring,
    isActive: holiday.isActive,
    isSystem: holiday.isSystem,
    version: holiday.version,
  };
}
