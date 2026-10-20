import type { NotificationDto, ReadAllResultDto, UnreadCountDto } from '@contrataflow/validation';

import { apiRequest } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

/*
 * Central de notificações (US-111 · SCR-036): NTF-01..05 de api/13-dashboard-notifications-audit.md.
 * Chaves `['t', tenantId, 'notifications', …]` (RN-FND-90): toda mutação invalida a raiz —
 * contador e lista juntos.
 */

export const notificationKeys = {
  all: (tenantId: string) => tenantKey(tenantId, 'notifications'),
  unreadCount: (tenantId: string) => tenantKey(tenantId, 'notifications', 'unread-count'),
  list: (tenantId: string, filter: NotificationFilter) =>
    tenantKey(tenantId, 'notifications', 'list', filter),
};

export type NotificationFilter = 'all' | 'unread';

/** Intervalo do contador do sininho (refetch periódico — o canal em tempo real fica para depois). */
export const UNREAD_COUNT_REFETCH_MS = 30_000;

/** Itens por página da lista completa e do painel do sininho. */
export const LIST_PAGE_SIZE = 20;
export const PANEL_SIZE = 5;

export interface NotificationPage {
  readonly items: readonly NotificationDto[];
  readonly nextCursor: string | null;
}

/** NTF-01. */
export async function fetchNotifications(
  options: {
    readonly cursor?: string | null | undefined;
    readonly limit: number;
    readonly filter: NotificationFilter;
  },
  signal?: AbortSignal,
): Promise<NotificationPage> {
  const result = await apiRequest<NotificationDto[]>('/notifications', {
    query: {
      limit: options.limit,
      cursor: options.cursor ?? undefined,
      unreadOnly: options.filter === 'unread' ? true : undefined,
    },
    signal,
  });
  const nextCursor = result.meta.nextCursor;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  };
}

/** NTF-02 — resposta fora do formato conta como zero (o sininho nunca quebra o shell). */
export async function fetchUnreadCount(signal?: AbortSignal): Promise<number> {
  const result = await apiRequest<Partial<UnreadCountDto> | undefined>(
    '/notifications/unread-count',
    {
      signal,
    },
  );
  return typeof result.data?.count === 'number' ? result.data.count : 0;
}

/** NTF-03. */
export function markNotificationRead(id: string): Promise<ApiResult<NotificationDto>> {
  return apiRequest<NotificationDto>(`/notifications/${id}/read`, { method: 'POST' });
}

/** NTF-04. */
export function markAllNotificationsRead(): Promise<ApiResult<ReadAllResultDto>> {
  return apiRequest<ReadAllResultDto>('/notifications/read-all', { method: 'POST' });
}

/** NTF-05. */
export function archiveNotification(id: string): Promise<ApiResult<NotificationDto>> {
  return apiRequest<NotificationDto>(`/notifications/${id}/archive`, { method: 'POST' });
}
