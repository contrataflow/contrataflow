import { isNotificationType } from '@contrataflow/types';
import type { NotificationChannel } from '@contrataflow/types';

import { currentRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';

import type { NotificationPreferenceRepository } from '../application/notification-ports.js';
import type { PreferenceDelta, StoredPreference } from '../domain/notification-preference.js';

/**
 * Preferências em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isoladas pelo tenant do contexto e pelo usuário, uma entrada por
 * `(tenant, usuário, tipo, canal)`.
 */
export class InMemoryNotificationPreferenceRepository implements NotificationPreferenceRepository {
  /** Chave `tenant|usuário|tipo|canal` → `enabled`. */
  private readonly rows = new Map<string, boolean>();

  private owner(userId: string): string {
    return `${currentRequestContext()?.tenantId ?? ''}|${userId}|`;
  }

  list(_tx: TenantTx, userId: string): Promise<StoredPreference[]> {
    const owner = this.owner(userId);
    const found: StoredPreference[] = [];
    for (const [key, enabled] of this.rows) {
      if (!key.startsWith(owner)) continue;
      const [notificationType, channel] = key.slice(owner.length).split('|');
      if (!isNotificationType(notificationType)) continue;
      found.push({ notificationType, channel: channel as NotificationChannel, enabled });
    }
    return Promise.resolve(found);
  }

  apply(_tx: TenantTx, userId: string, deltas: readonly PreferenceDelta[]): Promise<void> {
    const owner = this.owner(userId);
    for (const { notificationType, channel, to } of deltas) {
      const key = `${owner}${notificationType}|${channel}`;
      if (to === null) this.rows.delete(key);
      else this.rows.set(key, to);
    }
    return Promise.resolve();
  }
}
