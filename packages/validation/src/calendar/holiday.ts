import {
  DAY_COUNT_TYPES,
  HOLIDAY_SCOPES,
  MANAGED_HOLIDAY_SCOPES,
  MAX_ADD_BUSINESS_DAYS,
} from '@contrataflow/types';
import { z } from 'zod';

import { isoDateTimeSchema } from '../common/dates.js';
import { uuidV7Schema } from '../common/identifiers.js';
import { trimmedString } from '../common/text.js';

/*
 * Calendário de dias úteis (US-106 · entities.md §4 `Holiday` · api/14-tenant-administration.md
 * CAL-01..06 · RN-TEN-74..79). Datas `YYYY-MM-DD` sem fuso (DEC-003); instantes em ISO 8601 UTC.
 */

export const holidayScopeSchema = z.enum(HOLIDAY_SCOPES, { error: 'Selecione o escopo.' });
/** Escopos que o administrador cadastra: `NATIONAL` só vem do seed (RN-TEN-74). */
export const managedHolidayScopeSchema = z.enum(MANAGED_HOLIDAY_SCOPES, {
  error: 'Selecione o escopo.',
});

/** Data de calendário real `YYYY-MM-DD` (rejeita `2026-02-30`). */
export const calendarDateSchema = z.iso.date({
  error: (issue) => (issue.input === undefined ? 'Informe a data.' : 'Informe uma data válida.'),
});

const holidayNameSchema = trimmedString({ max: 120 });

export const holidayIdParamsSchema = z.strictObject({ id: uuidV7Schema });

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

/** CAL-01: `year` é opcional (padrão: o ano corrente no fuso do tenant). */
export const holidayListQuerySchema = z.strictObject({
  year: z.coerce
    .number({ error: 'Informe um ano válido.' })
    .int({ error: 'Informe um ano válido.' })
    .min(MIN_YEAR, { error: 'Informe um ano válido.' })
    .max(MAX_YEAR, { error: 'Informe um ano válido.' })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});
export type HolidayListQuery = z.output<typeof holidayListQuerySchema>;

/** CAL-02: `isSystem` e `isActive` não são aceitos do cliente (descartados no parse). */
export const createHolidaySchema = z.object({
  date: calendarDateSchema,
  name: holidayNameSchema,
  scope: managedHolidayScopeSchema,
  isRecurring: z.boolean({ error: 'Informe se o feriado é recorrente.' }).optional(),
});
export type CreateHoliday = z.output<typeof createHolidaySchema>;

/**
 * CAL-03: a data não muda (excluir e recadastrar). Em feriado de sistema só `isActive` e `scope`
 * são alteráveis — `name`/`isRecurring` diferentes dos atuais → `CATALOG_ITEM_SYSTEM`.
 */
export const updateHolidaySchema = z.object({
  name: holidayNameSchema.optional(),
  scope: holidayScopeSchema.optional(),
  isRecurring: z.boolean({ error: 'Informe se o feriado é recorrente.' }).optional(),
  isActive: z.boolean({ error: 'Informe se o feriado está ativo.' }).optional(),
});
export type UpdateHoliday = z.output<typeof updateHolidaySchema>;

/** Janela máxima de CAL-05 (3 anos de calendário). */
export const MAX_BUSINESS_DAYS_RANGE = 1100;

/** CAL-05 (query): `from` ≤ `to`, no máximo 1.100 dias; a regra do intervalo é do caso de uso. */
export const businessDaysQuerySchema = z.strictObject({
  from: calendarDateSchema,
  to: calendarDateSchema,
});
export type BusinessDaysQuery = z.output<typeof businessDaysQuerySchema>;

/** CAL-06: `businessDays` de 0 a 1.000 (V-05); `dayCountType` padrão `BUSINESS`. */
export const addBusinessDaysSchema = z.strictObject({
  fromDateTime: isoDateTimeSchema,
  businessDays: z
    .number({ error: 'Informe a quantidade de dias.' })
    .int({ error: 'Informe um número inteiro.' })
    .min(0, { error: 'Informe um valor entre 0 e 1000.' })
    .max(MAX_ADD_BUSINESS_DAYS, { error: 'Informe um valor entre 0 e 1000.' }),
  dayCountType: z.enum(DAY_COUNT_TYPES, { error: 'Informe BUSINESS ou CALENDAR.' }).optional(),
});
export type AddBusinessDays = z.output<typeof addBusinessDaysSchema>;

/** `Holiday` da resposta (CAL-01..03). */
export const holidaySchema = z.object({
  id: z.uuid(),
  date: z.iso.date(),
  name: z.string(),
  scope: holidayScopeSchema,
  isRecurring: z.boolean(),
  isActive: z.boolean(),
  isSystem: z.boolean(),
  version: z.int(),
});
export type HolidayDto = z.infer<typeof holidaySchema>;

/** CAL-05: `data` da resposta. */
export const businessDaysResultSchema = z.object({
  businessDays: z.int(),
  dates: z.array(z.iso.date()),
});
export type BusinessDaysResult = z.infer<typeof businessDaysResultSchema>;

/** CAL-06: `data` da resposta. */
export const addBusinessDaysResultSchema = z.object({ dueDateTime: z.iso.datetime() });
export type AddBusinessDaysResult = z.infer<typeof addBusinessDaysResultSchema>;
