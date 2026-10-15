import {
  EMAIL_DELIVERY_STATUSES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
} from '@contrataflow/types';
import { z } from 'zod';

import { uuidV7Schema } from '../common/identifiers.js';
import { cursorQuerySchema } from '../http/pagination.js';

/*
 * Central de notificações in-app (US-111 · entities.md `Notification` · api/13-dashboard-
 * notifications-audit.md NTF-01..05). Só o destinatário lê e altera as próprias notificações.
 */

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export const notificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);

export const notificationIdParamsSchema = z.strictObject({ id: uuidV7Schema });

/** NTF-01: cursor opaco, `limit` ≤ 100 e `unreadOnly` (`true`/`false`, padrão `false`). */
export const notificationListQuerySchema = cursorQuerySchema.extend({
  limit: cursorQuerySchema.shape.limit.default(20),
  unreadOnly: z
    .enum(['true', 'false'], { error: 'Informe "true" ou "false" em "unreadOnly".' })
    .transform((value) => value === 'true')
    .default(false),
});
export type NotificationListQuery = z.output<typeof notificationListQuerySchema>;

/** `Notification` das respostas de NTF-01/03/05. */
export const notificationSchema = z
  .object({
    id: z.uuid(),
    type: notificationTypeSchema,
    priority: notificationPrioritySchema,
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    processId: z.uuid().nullable(),
    entityType: z.string().nullable(),
    entityId: z.uuid().nullable(),
    groupKey: z.string().nullable(),
    groupCount: z.int().min(1),
    groupedEventIds: z.array(z.uuid()),
    readAt: z.iso.datetime().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    emailStatus: emailDeliveryStatusSchema,
    emailSentAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Notification' });
export type NotificationDto = z.infer<typeof notificationSchema>;

/** NTF-02. */
export const unreadCountSchema = z.object({ count: z.int().min(0) });
export type UnreadCountDto = z.infer<typeof unreadCountSchema>;

/** NTF-04: quantas notificações foram marcadas como lidas. */
export const readAllResultSchema = z.object({ updated: z.int().min(0) });
export type ReadAllResultDto = z.infer<typeof readAllResultSchema>;
