import {
  EMAIL_DELIVERY_STATUSES,
  NOTIFICATION_CHANNELS,
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

/*
 * Preferências de notificação (US-113 · ME-05/ME-06 · api/01-session-me.md): por
 * (tipo, canal); ausência de linha = padrão do registro `NotificationType`.
 */

export const NOTIFICATION_PREFERENCE_LOCKED_MESSAGE = 'Este aviso não pode ser desligado.';
export const NOTIFICATION_PREFERENCES_EMPTY_MESSAGE = 'Nenhuma alteração reconhecida.';
export const NOTIFICATION_TYPE_INVALID_MESSAGE = 'Tipo de notificação inválido.';

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/** Um item de ME-05/ME-06: o valor efetivo e se o usuário pode alterá-lo (RN-NTF-23). */
export const notificationPreferenceSchema = z
  .object({
    notificationType: notificationTypeSchema,
    channel: notificationChannelSchema,
    enabled: z.boolean(),
    editable: z.boolean(),
  })
  .meta({ id: 'NotificationPreference' });
export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>;

/** Um item do corpo de ME-06. `enabled: null` = "usar padrão" (FA-01): apaga a preferência salva. */
const notificationPreferenceChangeSchema = z.strictObject({
  notificationType: z.enum(NOTIFICATION_TYPES, { error: NOTIFICATION_TYPE_INVALID_MESSAGE }),
  channel: notificationChannelSchema,
  enabled: z.boolean().nullable(),
});
export type NotificationPreferenceChange = z.infer<typeof notificationPreferenceChangeSchema>;

/**
 * ME-06 (corpo): merge das combinações enviadas (RN-NTF-25); lista não vazia e sem repetir a mesma
 * combinação. A trava dos tipos obrigatórios (RN-NTF-23) é regra de domínio, aplicada pelo caso de uso.
 */
export const updateNotificationPreferencesSchema = z.strictObject({
  preferences: z
    .array(notificationPreferenceChangeSchema)
    .min(1, { error: NOTIFICATION_PREFERENCES_EMPTY_MESSAGE })
    .max(NOTIFICATION_TYPES.length * NOTIFICATION_CHANNELS.length, {
      error: NOTIFICATION_PREFERENCES_EMPTY_MESSAGE,
    })
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        const key = `${item.notificationType}:${item.channel}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: 'Envie cada combinação de tipo e canal uma única vez.',
            params: { code: 'DUPLICATE_IN_LIST' },
          });
        }
        seen.add(key);
      });
    }),
});
export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>;
