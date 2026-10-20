import type { HolidayScope } from '@contrataflow/types';
import type { HolidayDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Calendário de dias úteis (US-106 · SCR-110): CAL-01..04 de api/14-tenant-administration.md. As
 * chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90). CAL-05/CAL-06 (dias úteis e soma de
 * prazo) são consumidos pelas telas de prazo (US-047/US-055), não por esta.
 */

export const calendarKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'calendar'),
  holidays: (tenantId: string, year: number) =>
    tenantKey(tenantId, 'calendar', 'holidays', String(year)),
};

/** Staleness do calendário (architecture.md §8.5: catálogos e configurações). */
export const CALENDAR_STALE_TIME_MS = 5 * 60_000;

/** Algumas dezenas de feriados por ano: uma única página de 200 (máximo da API) basta. */
const PAGE_SIZE = 200;

/** CAL-01: feriados do ano (ativos e inativos) por data. */
export function fetchHolidays(
  year: number,
  signal?: AbortSignal,
): Promise<ApiResult<HolidayDto[]>> {
  return apiRequest<HolidayDto[]>('/holidays', {
    query: { year, page: 1, pageSize: PAGE_SIZE },
    signal,
  });
}

export interface CreateHolidayBody {
  readonly date: string;
  readonly name: string;
  readonly scope: HolidayScope;
  readonly isRecurring: boolean;
}

/** CAL-02. */
export function createHoliday(body: CreateHolidayBody): Promise<ApiResult<HolidayDto>> {
  return apiRequest<HolidayDto>('/holidays', { method: 'POST', body });
}

export interface HolidayPatch {
  readonly name?: string;
  readonly scope?: HolidayScope;
  readonly isRecurring?: boolean;
  readonly isActive?: boolean;
}

/** CAL-03: só os campos alterados, com a versão lida em `If-Match`. */
export function updateHoliday(
  id: string,
  patch: HolidayPatch,
  version: number,
): Promise<ApiResult<HolidayDto>> {
  return apiRequest<HolidayDto>(`/holidays/${id}`, {
    method: 'PATCH',
    body: patch,
    ifMatch: `"${version}"`,
  });
}

/** CAL-04: exclusão (só feriado que não é de sistema), com `If-Match`. */
export function deleteHoliday(id: string, version: number): Promise<ApiResult<undefined>> {
  return apiRequest<undefined>(`/holidays/${id}`, {
    method: 'DELETE',
    ifMatch: `"${version}"`,
  });
}
