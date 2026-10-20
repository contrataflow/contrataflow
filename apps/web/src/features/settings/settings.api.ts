import type {
  NumberingPreview,
  NumberingPreviewResult,
  SettingsMapDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Configurações do tenant (US-103 · SCR-041): SET-01..03 de api/14-tenant-administration.md. As
 * chaves seguem a convenção `['t', tenantId, …]` (RN-FND-90).
 */

export const settingsKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'settings'),
  full: (tenantId: string) => tenantKey(tenantId, 'settings', 'full'),
  public: (tenantId: string) => tenantKey(tenantId, 'settings', 'public'),
  numberingPreview: (tenantId: string, request: NumberingPreview) =>
    tenantKey(tenantId, 'settings', 'numbering-preview', request),
};

/** Staleness das configurações (architecture.md §8.5: catálogos e configurações). */
export const SETTINGS_STALE_TIME_MS = 5 * 60_000;

/** SET-01 (exige `SETTINGS_MANAGE`). */
export function fetchSettings(signal?: AbortSignal): Promise<ApiResult<SettingsMapDto>> {
  return apiRequest<SettingsMapDto>('/settings', { signal });
}

/** SET-03: só as chaves públicas (rótulos e marca), a qualquer vínculo ativo. */
export function fetchPublicSettings(
  signal?: AbortSignal,
): Promise<ApiResult<Record<string, unknown>>> {
  return apiRequest<Record<string, unknown>>('/settings/public', { signal });
}

/** SET-02: lote tudo ou nada; `expectedVersions` por chave alterada (RN-TEN-54). */
export function updateSettings(
  values: Readonly<Record<string, unknown>>,
  expectedVersions: Readonly<Record<string, number>>,
): Promise<ApiResult<SettingsMapDto>> {
  return apiRequest<SettingsMapDto>('/settings', {
    method: 'PATCH',
    body: { values, expectedVersions },
  });
}

/** SET-04 (US-105): exemplo da máscara ainda não salva, sem incrementar a sequência. */
export function previewNumbering(
  request: NumberingPreview,
  signal?: AbortSignal,
): Promise<ApiResult<NumberingPreviewResult>> {
  return apiRequest<NumberingPreviewResult>('/numbering/preview', {
    method: 'POST',
    body: request,
    signal,
  });
}
