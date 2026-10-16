import type {
  NotificationPreferenceChange,
  NotificationPreferenceDto,
} from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Preferências de notificação (US-113 · SCR-039, aba "Notificações"): ME-05/ME-06 de
 * api/01-session-me.md. As preferências são do vínculo da instituição ativa (RN-NTF-22), então a
 * chave segue `['t', tenantId, …]` (RN-FND-90) e nada sobrevive à troca de instituição.
 */

export const notificationPreferencesKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'me', 'notification-preferences'),
};

/** Staleness: muda só quando o próprio usuário salva (a mutação grava o novo estado no cache). */
export const NOTIFICATION_PREFERENCES_STALE_TIME_MS = 5 * 60_000;

export interface NotificationPreferencesState {
  readonly items: readonly NotificationPreferenceDto[];
  /** `notifications.emailEnabled` do órgão: desligado, a coluna de e-mail fica inerte (RN-NTF-24). */
  readonly emailEnabled: boolean;
}

interface PreferencesResponse {
  readonly data: NotificationPreferenceDto[];
  readonly emailEnabled: boolean;
}

async function request(
  method: 'GET' | 'PUT',
  body: unknown,
  signal?: AbortSignal,
): Promise<NotificationPreferencesState> {
  const result = await apiRequest<PreferencesResponse['data']>('/me/notification-preferences', {
    method,
    body,
    signal,
  });
  return {
    items: Array.isArray(result.data) ? result.data : [],
    // Sem o campo, o e-mail segue disponível (o padrão do órgão é ligado).
    emailEnabled: result.meta.emailEnabled !== false,
  };
}

/** ME-05. */
export function fetchNotificationPreferences(
  signal?: AbortSignal,
): Promise<NotificationPreferencesState> {
  return request('GET', undefined, signal);
}

/** ME-06: envia só as combinações alteradas (merge — RN-NTF-25); `enabled: null` = usar o padrão. */
export function updateNotificationPreferences(
  preferences: readonly NotificationPreferenceChange[],
): Promise<NotificationPreferencesState> {
  return request('PUT', { preferences });
}
