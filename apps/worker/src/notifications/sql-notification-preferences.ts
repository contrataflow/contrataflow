import { isNotificationType } from '@contrataflow/types';
import type { NotificationType } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { NotificationPreferences, RecipientPreference } from './recipient-resolver.js';

interface PreferenceRow {
  readonly user_id: string;
  readonly channel: string;
  readonly enabled: boolean;
}

/**
 * `NotificationPreferences` sobre `notification_preferences` (US-113): uma consulta por despacho,
 * no `client` da transação do tenant (a RLS restringe ao tenant do job). Lida a cada despacho, sem
 * cache: a escolha do usuário vale já na próxima notificação gerada. Quem não tem linha para o
 * canal segue o padrão do registro.
 */
export class SqlNotificationPreferences implements NotificationPreferences {
  async preferences(
    client: SqlClient,
    type: NotificationType,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, RecipientPreference>> {
    if (userIds.length === 0 || !isNotificationType(type)) return new Map();
    const { rows } = await client.query<PreferenceRow>(
      `SELECT user_id, channel, enabled
         FROM notification_preferences
        WHERE notification_type = $1 AND user_id = ANY($2::uuid[])`,
      [type, userIds],
    );
    const byUser = new Map<string, { email?: boolean; inApp?: boolean }>();
    for (const row of rows) {
      const current = byUser.get(row.user_id) ?? {};
      if (row.channel === 'EMAIL') current.email = row.enabled;
      else if (row.channel === 'IN_APP') current.inApp = row.enabled;
      byUser.set(row.user_id, current);
    }
    return byUser;
  }
}
