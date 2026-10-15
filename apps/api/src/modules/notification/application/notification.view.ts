import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  isRelativeNotificationLink,
  scrubNotificationText,
} from '@contrataflow/types';
import type { NotificationDto } from '@contrataflow/validation';

import type { Notification } from '../domain/notification.js';

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * `NotificationPresenter` (Impacto técnico da US-111 · RN-NTF-07/08): defesa em profundidade — o
 * dispatcher já grava conteúdo sem valores sigilosos e link relativo, mas o que sai pela API passa
 * de novo pelo mascaramento, e link fora do formato é descartado.
 */
export function toNotificationDto(notification: Notification): NotificationDto {
  return {
    id: notification.id,
    type: notification.type,
    priority: notification.priority,
    title: scrubNotificationText(notification.title, NOTIFICATION_TITLE_MAX),
    body: scrubNotificationText(notification.body, NOTIFICATION_BODY_MAX),
    link:
      notification.link !== null && isRelativeNotificationLink(notification.link)
        ? notification.link
        : null,
    processId: notification.processId,
    entityType: notification.entityType,
    entityId: notification.entityId,
    groupKey: notification.groupKey,
    groupCount: notification.groupCount,
    groupedEventIds: [...notification.groupedEventIds],
    readAt: iso(notification.readAt),
    archivedAt: iso(notification.archivedAt),
    emailStatus: notification.emailStatus,
    emailSentAt: iso(notification.emailSentAt),
    createdAt: notification.createdAt.toISOString(),
  };
}
