import { isNotificationType } from '@contrataflow/types';
import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '#shared/context/request-context.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { NotificationPreferenceRepository } from '../application/notification-ports.js';
import type { PreferenceDelta, StoredPreference } from '../domain/notification-preference.js';

/**
 * `notification_preferences` no PostgreSQL (US-113): no `tx` do caso de uso, sob a RLS do tenant e a
 * extensão de isolamento (que injeta e confere o `tenantId`). A gravação é `INSERT … ON CONFLICT`
 * pela chave única `(tenant, usuário, tipo, canal)` — duas requisições simultâneas não se perdem
 * nem duplicam linha (RN-NTF-22/25).
 */
@Injectable()
export class PrismaNotificationPreferenceRepository implements NotificationPreferenceRepository {
  async list(tx: TenantTx, userId: string): Promise<StoredPreference[]> {
    const rows = await tx.notificationPreference.findMany({ where: { userId } });
    return rows.flatMap((row) =>
      // Tipo fora do registro (removido numa versão futura) é ignorado, nunca devolvido.
      isNotificationType(row.notificationType)
        ? [{ notificationType: row.notificationType, channel: row.channel, enabled: row.enabled }]
        : [],
    );
  }

  async apply(tx: TenantTx, userId: string, deltas: readonly PreferenceDelta[]): Promise<void> {
    const { tenantId } = requireRequestContext();
    if (tenantId === null) throw new Error('notification_preferences: rota de tenant sem tenant');
    for (const delta of deltas) {
      const { notificationType, channel } = delta;
      if (delta.to === null) {
        await tx.notificationPreference.deleteMany({
          where: { userId, notificationType, channel },
        });
        continue;
      }
      await tx.notificationPreference.upsert({
        where: {
          tenantId_userId_notificationType_channel: {
            tenantId,
            userId,
            notificationType,
            channel,
          },
        },
        create: { id: newId(), tenantId, userId, notificationType, channel, enabled: delta.to },
        update: { enabled: delta.to },
      });
    }
  }
}
