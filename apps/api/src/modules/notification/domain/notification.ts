import type {
  EmailDeliveryStatus,
  NotificationPriority,
  NotificationType,
} from '@contrataflow/types';

/**
 * `Notification` (entities.md · US-111): aviso in-app de UM destinatário, gravado pelo
 * `NotificationDispatcher` do worker. Pela API só mudam `readAt` (NTF-03/04) e `archivedAt`
 * (NTF-05), sempre do próprio destinatário (RN-NTF-11/12).
 */
export interface Notification {
  readonly id: string;
  readonly tenantId: string;
  readonly recipientId: string;
  readonly type: NotificationType;
  readonly priority: NotificationPriority;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly processId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly sourceEventId: string;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly groupedEventIds: readonly string[];
  readonly emailStatus: EmailDeliveryStatus;
  readonly emailSentAt: Date | null;
  readonly readAt: Date | null;
  readonly archivedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/** Vencida (RN-NTF-09): `expiresAt` preenchido e já passado. */
export function isExpired(notification: Pick<Notification, 'expiresAt'>, now: Date): boolean {
  return notification.expiresAt !== null && notification.expiresAt.getTime() <= now.getTime();
}

/** Aparece na lista padrão (RN-NTF-09): não arquivada e não vencida. */
export function isListed(
  notification: Pick<Notification, 'archivedAt' | 'expiresAt'>,
  now: Date,
): boolean {
  return notification.archivedAt === null && !isExpired(notification, now);
}

/** Conta para o sininho (RN-NTF-10): listada e ainda não lida. */
export function isUnread(
  notification: Pick<Notification, 'archivedAt' | 'expiresAt' | 'readAt'>,
  now: Date,
): boolean {
  return isListed(notification, now) && notification.readAt === null;
}
